
var cls = require("./lib/class"),
    _ = require("underscore"),
    Log = require('log'),
    Entity = require('./entity'),
    Character = require('./character'),
    Mob = require('./mob'),
    Map = require('./map'),
    Npc = require('./npc'),
    Player = require('./player');

// Make Entity, Character, Mob and Player available as globals BEFORE loading
// modules that extend them at require-time.  item.js does `Entity.extend`,
// npc.js does `Entity.extend`, and chest.js does `Item.extend`.  Without
// these assignments those modules would crash on load.
global.Entity    = Entity;
global.Character = Character;
global.Mob       = Mob;
global.Player    = Player;

var Item = require('./item'),
    MobArea = require('./mobarea'),
    ChestArea = require('./chestarea');

// item.js is now loaded; expose it globally so chest.js (which does
// `Item.extend`) can find it.
global.Item = Item;

var Chest = require('./chest'),
    Messages = require('./message'),
    Properties = require("./properties"),
    Utils = require("./utils"),
    Types = require("../../shared/js/gametypes"),
    EntityRegistry   = require("./entityregistry"),
    BroadcastManager = require("./broadcastmanager"),
    ZoneManager      = require("./zonemanager"),
    CombatHandler    = require("./combathandler"),
    ItemManager      = require("./itemmanager");

// Chest is loaded; expose globally for completeness.
global.Chest = Chest;

// ======= GAME SERVER ========

module.exports = World = cls.Class.extend({
    init: function(id, maxPlayers, websocketServer) {
        var self = this;

        this.id = id;
        this.maxPlayers = maxPlayers;
        this.server = websocketServer;
        this.ups = 50;

        this.map = null;

        // ---- sub-modules ------------------------------------------------
        // Each sub-module owns a specific slice of world state.  The World
        // acts as coordinator and public façade.

        this.entityRegistry   = new EntityRegistry();
        this.broadcastManager = new BroadcastManager(websocketServer, this.entityRegistry);
        this.combatHandler    = new CombatHandler(this);
        this.itemManager      = new ItemManager(this);
        // zoneManager is created in run() once the map is available.
        this.zoneManager      = null;

        // ---- world-level counters ---------------------------------------
        this.playerCount     = 0;
        this.zoneGroupsReady = false;

        // ---- event callbacks --------------------------------------------
        // Kept on the World so that player.js and main.js can still access
        // them via this.server.*_callback as before.
        this.connect_callback = null;
        this.enter_callback   = null;
        this.added_callback   = null;
        this.removed_callback = null;
        this.attack_callback  = null;
        this.regen_callback   = null;
        this.init_callback    = null;

        // ---- player connect: checkpoint position ------------------------
        this.onPlayerConnect(function(player) {
            player.onRequestPosition(function() {
                if(player.lastCheckpoint) {
                    return player.lastCheckpoint.getRandomPosition();
                } else {
                    return self.map.getRandomStartingPosition();
                }
            });
        });

        // ---- player enter: full join flow --------------------------------
        this.onPlayerEnter(function(player) {
            log.info(player.name + " has joined " + self.id);

            if(!player.hasEnteredGame) {
                self.incrementPlayerCount();
            }

            // Number of players in this world
            self.pushToPlayer(player, new Messages.Population(self.playerCount));
            self.pushRelevantEntityListTo(player);

            var move_callback = function(x, y) {
                log.debug(player.name + " is moving to (" + x + ", " + y + ").");

                player.forEachAttacker(function(mob) {
                    var target = self.getEntityById(mob.target);
                    if(target) {
                        var pos = self.findPositionNextTo(mob, target);
                        if(mob.distanceToSpawningPoint(pos.x, pos.y) > 50) {
                            mob.clearTarget();
                            mob.forgetEveryone();
                            player.removeAttacker(mob);
                        } else {
                            self.moveEntity(mob, pos.x, pos.y);
                        }
                    }
                });
            };

            player.onMove(move_callback);
            player.onLootMove(move_callback);

            player.onZone(function() {
                var hasChangedGroups = self.handleEntityGroupMembership(player);

                if(hasChangedGroups) {
                    self.pushToPreviousGroups(player, new Messages.Destroy(player));
                    self.pushRelevantEntityListTo(player);
                }
            });

            player.onBroadcast(function(message, ignoreSelf) {
                self.pushToAdjacentGroups(player.group, message, ignoreSelf ? player.id : null);
            });

            player.onBroadcastToZone(function(message, ignoreSelf) {
                self.pushToGroup(player.group, message, ignoreSelf ? player.id : null);
            });

            player.onExit(function() {
                log.info(player.name + " has left the game.");
                self.removePlayer(player);
                self.decrementPlayerCount();

                if(self.removed_callback) {
                    self.removed_callback();
                }
            });

            if(self.added_callback) {
                self.added_callback();
            }
        });

        // ---- entity attack -----------------------------------------------
        this.onEntityAttack(function(attacker) {
            var target = self.getEntityById(attacker.target);
            if(target && attacker.type === "mob") {
                var pos = self.findPositionNextTo(attacker, target);
                self.moveEntity(attacker, pos.x, pos.y);
            }
        });

        // ---- regen tick --------------------------------------------------
        this.onRegenTick(function() {
            self.forEachCharacter(function(character) {
                if(!character.hasFullHealth()) {
                    character.regenHealthBy(Math.floor(character.maxHitPoints / 25));

                    if(character.type === 'player') {
                        self.pushToPlayer(character, character.regen());
                    }
                }
            });
        });
    },

    // =====================================================================
    // Lifecycle
    // =====================================================================

    run: function(mapFilePath) {
        var self = this;

        this.map = new Map(mapFilePath);

        // The zone manager needs the map to enumerate groups.
        this.zoneManager = new ZoneManager(this.map);

        // Wire the broadcast manager so it can resolve groups and iterate
        // adjacent zones.
        this.broadcastManager.setMap(this.map);
        this.broadcastManager.setZoneManager(this.zoneManager);

        // Chest-area instances are created during map.ready and kept here
        // so tryAddingMobToChestArea and _finalizeChestAreas can reach them.
        this._chestAreas = [];

        this.map.ready(function() {
            self.zoneManager.initZoneGroups();
            self.zoneGroupsReady = true;

            self.map.generateCollisionGrid();

            // Populate all mob "roaming" areas
            _.each(self.map.mobAreas, function(a) {
                var area = new MobArea(a.id, a.nb, a.type, a.x, a.y, a.width, a.height, self);
                area.spawnMobs();
                area.onEmpty(self.handleEmptyMobArea.bind(self, area));
            });

            // Create all chest areas
            _.each(self.map.chestAreas, function(a) {
                var area = new ChestArea(a.id, a.x, a.y, a.w, a.h, a.tx, a.ty, a.i, self);
                self._chestAreas.push(area);
                area.onEmpty(self.handleEmptyChestArea.bind(self, area));
            });

            // Spawn static chests
            _.each(self.map.staticChests, function(chest) {
                var c = self.createChest(chest.x, chest.y, chest.i);
                self.addStaticItem(c);
            });

            // Spawn static entities
            self.spawnStaticEntities();

            // Set maximum number of entities contained in each chest area
            _.each(self._chestAreas, function(area) {
                area.setNumberOfEntities(area.entities.length);
            });
        });

        var regenCount = this.ups * 2;
        var updateCount = 0;
        setInterval(function() {
            self.processGroups();
            self.processQueues();

            if(updateCount < regenCount) {
                updateCount += 1;
            } else {
                if(self.regen_callback) {
                    self.regen_callback();
                }
                updateCount = 0;
            }
        }, 1000 / this.ups);

        log.info("" + this.id + " created (capacity: " + this.maxPlayers + " players).");
    },

    setUpdatesPerSecond: function(ups) {
        this.ups = ups;
    },

    // =====================================================================
    // Callback registration  (unchanged public API)
    // =====================================================================

    onInit: function(callback) {
        this.init_callback = callback;
    },

    onPlayerConnect: function(callback) {
        this.connect_callback = callback;
    },

    onPlayerEnter: function(callback) {
        this.enter_callback = callback;
    },

    onPlayerAdded: function(callback) {
        this.added_callback = callback;
    },

    onPlayerRemoved: function(callback) {
        this.removed_callback = callback;
    },

    onRegenTick: function(callback) {
        this.regen_callback = callback;
    },

    onEntityAttack: function(callback) {
        this.attack_callback = callback;
    },

    // =====================================================================
    // Entity CRUD  (delegates to entityRegistry + sub-modules)
    // =====================================================================

    addEntity: function(entity) {
        this.entityRegistry.add(entity);
        this.handleEntityGroupMembership(entity);
    },

    removeEntity: function(entity) {
        this.entityRegistry.remove(entity);
        this.entityRegistry.removeFromTypeCollections(entity);

        if(entity.type === "mob") {
            this.clearMobAggroLink(entity);
            this.clearMobHateLinks(entity);
        }

        entity.destroy();
        this.removeFromGroups(entity);
        log.debug("Removed " + Types.getKindAsString(entity.kind) + " : " + entity.id);
    },

    getEntityById: function(id) {
        return this.entityRegistry.getEntity(id);
    },

    // =====================================================================
    // Player management
    // =====================================================================

    addPlayer: function(player) {
        this.addEntity(player);
        this.entityRegistry.addPlayer(player);
        this.broadcastManager.addPlayerQueue(player.id);
    },

    removePlayer: function(player) {
        player.broadcast(player.despawn());
        this.removeEntity(player);
        this.entityRegistry.removePlayer(player);
        this.broadcastManager.removePlayerQueue(player.id);
    },

    // =====================================================================
    // Mob management
    // =====================================================================

    addMob: function(mob) {
        this.addEntity(mob);
        this.entityRegistry.addMob(mob);
    },

    // =====================================================================
    // NPC management
    // =====================================================================

    addNpc: function(kind, x, y) {
        var npc = new Npc('8' + x + '' + y, kind, x, y);
        this.addEntity(npc);
        this.entityRegistry.addNpc(npc);
        return npc;
    },

    // =====================================================================
    // Item management  (delegates to itemManager)
    // =====================================================================

    addItem: function(item) {
        return this.itemManager.addItem(item);
    },

    createItem: function(kind, x, y) {
        return this.itemManager.createItem(kind, x, y);
    },

    createChest: function(x, y, items) {
        return this.itemManager.createChest(x, y, items);
    },

    addStaticItem: function(item) {
        return this.itemManager.addStaticItem(item);
    },

    addItemFromChest: function(kind, x, y) {
        return this.itemManager.addItemFromChest(kind, x, y);
    },

    handleItemDespawn: function(item) {
        this.itemManager.handleItemDespawn(item);
    },

    handleOpenedChest: function(chest, player) {
        this.itemManager.handleOpenedChest(chest, player);
    },

    handleEmptyChestArea: function(area) {
        this.itemManager.handleEmptyChestArea(area);
    },

    handleEmptyMobArea: function(area) {
        // Intentionally empty – matches original.
    },

    // =====================================================================
    // Broadcasting  (delegates to broadcastManager)
    // =====================================================================

    pushRelevantEntityListTo: function(player) {
        var entities;
        if(player && this.zoneManager) {
            var group = this.zoneManager.getGroup(player.group);
            if(group) {
                entities = _.keys(group.entities);
                entities = _.reject(entities, function(id) { return id == player.id; });
                entities = _.map(entities, function(id) { return parseInt(id); });
                if(entities) {
                    this.pushToPlayer(player, new Messages.List(entities));
                }
            }
        }
    },

    pushSpawnsToPlayer: function(player, ids) {
        var self = this;
        _.each(ids, function(id) {
            var entity = self.getEntityById(id);
            if(entity) {
                self.pushToPlayer(player, new Messages.Spawn(entity));
            }
        });
        log.debug("Pushed " + _.size(ids) + " new spawns to " + player.id);
    },

    pushToPlayer: function(player, message) {
        this.broadcastManager.pushToPlayer(player, message);
    },

    pushToGroup: function(groupId, message, ignoredPlayer) {
        this.broadcastManager.pushToGroup(groupId, message, ignoredPlayer);
    },

    pushToAdjacentGroups: function(groupId, message, ignoredPlayer) {
        this.broadcastManager.pushToAdjacentGroups(groupId, message, ignoredPlayer);
    },

    pushToPreviousGroups: function(player, message) {
        this.broadcastManager.pushToPreviousGroups(player, message);
    },

    pushBroadcast: function(message, ignoredPlayer) {
        this.broadcastManager.pushBroadcast(message, ignoredPlayer);
    },

    processQueues: function() {
        this.broadcastManager.processQueues();
    },

    // =====================================================================
    // Zone / group management  (delegates to zoneManager)
    // =====================================================================

    initZoneGroups: function() {
        this.zoneManager.initZoneGroups();
        this.zoneGroupsReady = true;
    },

    removeFromGroups: function(entity) {
        if(!this.zoneManager) { return []; }
        return this.zoneManager.removeFromGroups(entity);
    },

    addAsIncomingToGroup: function(entity, groupId) {
        if(!this.zoneManager) { return; }
        this.zoneManager.addAsIncomingToGroup(entity, groupId);
    },

    addToGroup: function(entity, groupId) {
        if(!this.zoneManager) { return []; }
        return this.zoneManager.addToGroup(entity, groupId);
    },

    logGroupPlayers: function(groupId) {
        if(!this.zoneManager) { return; }
        this.zoneManager.logGroupPlayers(groupId);
    },

    handleEntityGroupMembership: function(entity) {
        if(!this.zoneManager) { return false; }
        return this.zoneManager.handleEntityGroupMembership(entity);
    },

    processGroups: function() {
        var self = this;
        if(this.zoneManager) {
            this.zoneManager.processGroups(function(groupId, entity) {
                if(entity instanceof Player) {
                    self.pushToGroup(groupId, new Messages.Spawn(entity), entity.id);
                } else {
                    self.pushToGroup(groupId, new Messages.Spawn(entity));
                }
            });
        }
    },

    // =====================================================================
    // Combat  (delegates to combatHandler)
    // =====================================================================

    handleMobHate: function(mobId, playerId, hatePoints) {
        this.combatHandler.handleMobHate(mobId, playerId, hatePoints);
    },

    chooseMobTarget: function(mob, hateRank) {
        this.combatHandler.chooseMobTarget(mob, hateRank);
    },

    clearMobAggroLink: function(mob) {
        this.combatHandler.clearMobAggroLink(mob);
    },

    clearMobHateLinks: function(mob) {
        this.combatHandler.clearMobHateLinks(mob);
    },

    broadcastAttacker: function(character) {
        this.combatHandler.broadcastAttacker(character);
    },

    handleHurtEntity: function(entity, attacker, damage) {
        this.combatHandler.handleHurtEntity(entity, attacker, damage);
    },

    handlePlayerVanish: function(player) {
        this.combatHandler.handlePlayerVanish(player);
    },

    getDroppedItem: function(mob) {
        return this.combatHandler.getDroppedItem(mob);
    },

    // =====================================================================
    // Iteration helpers  (delegates to entityRegistry)
    // =====================================================================

    forEachEntity: function(callback) {
        this.entityRegistry.forEachEntity(callback);
    },

    forEachPlayer: function(callback) {
        this.entityRegistry.forEachPlayer(callback);
    },

    forEachMob: function(callback) {
        this.entityRegistry.forEachMob(callback);
    },

    forEachCharacter: function(callback) {
        this.entityRegistry.forEachCharacter(callback);
    },

    // =====================================================================
    // Player count
    // =====================================================================

    getPlayerCount: function() {
        var count = 0;
        var players = this.entityRegistry.getPlayers();
        for(var p in players) {
            if(players.hasOwnProperty(p)) {
                count += 1;
            }
        }
        return count;
    },

    setPlayerCount: function(count) {
        this.playerCount = count;
    },

    incrementPlayerCount: function() {
        this.setPlayerCount(this.playerCount + 1);
    },

    decrementPlayerCount: function() {
        if(this.playerCount > 0) {
            this.setPlayerCount(this.playerCount - 1);
        }
    },

    // =====================================================================
    // Spatial helpers
    // =====================================================================

    isValidPosition: function(x, y) {
        if(this.map && _.isNumber(x) && _.isNumber(y)
           && !this.map.isOutOfBounds(x, y) && !this.map.isColliding(x, y)) {
            return true;
        }
        return false;
    },

    findPositionNextTo: function(entity, target) {
        var valid = false,
            pos;

        while(!valid) {
            pos = entity.getPositionNextTo(target);
            valid = this.isValidPosition(pos.x, pos.y);
        }
        return pos;
    },

    moveEntity: function(entity, x, y) {
        if(entity) {
            entity.setPosition(x, y);
            this.handleEntityGroupMembership(entity);
        }
    },

    despawn: function(entity) {
        this.pushToAdjacentGroups(entity.group, entity.despawn());

        if(this.entityRegistry.hasEntity(entity.id)) {
            this.removeEntity(entity);
        }
    },

    onMobMoveCallback: function(mob) {
        this.pushToAdjacentGroups(mob.group, new Messages.Move(mob));
        this.handleEntityGroupMembership(mob);
    },

    // =====================================================================
    // Static entity spawning
    // =====================================================================

    spawnStaticEntities: function() {
        var self = this,
            count = 0;

        _.each(this.map.staticEntities, function(kindName, tid) {
            var kind = Types.getKindFromString(kindName),
                pos  = self.map.tileIndexToGridPosition(tid);

            if(Types.isNpc(kind)) {
                self.addNpc(kind, pos.x + 1, pos.y);
            }
            if(Types.isMob(kind)) {
                var mob = new Mob('7' + kind + count++, kind, pos.x + 1, pos.y);
                mob.onRespawn(function() {
                    mob.isDead = false;
                    self.addMob(mob);
                    if(mob.area && mob.area instanceof ChestArea) {
                        mob.area.addToArea(mob);
                    }
                });
                mob.onMove(self.onMobMoveCallback.bind(self));
                self.addMob(mob);
                self.tryAddingMobToChestArea(mob);
            }
            if(Types.isItem(kind)) {
                self.addStaticItem(self.createItem(kind, pos.x + 1, pos.y));
            }
        });
    },

    tryAddingMobToChestArea: function(mob) {
        if(this._chestAreas) {
            _.each(this._chestAreas, function(area) {
                if(area.contains(mob)) {
                    area.addToArea(mob);
                }
            });
        }
    },

    // =====================================================================
    // Population
    // =====================================================================

    updatePopulation: function(totalPlayers) {
        this.pushBroadcast(
            new Messages.Population(this.playerCount,
                                    totalPlayers ? totalPlayers : this.playerCount));
    }
});
