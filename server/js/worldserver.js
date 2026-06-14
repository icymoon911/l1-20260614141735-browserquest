
var cls = require("./lib/class"),
    _ = require("underscore");

// Entity classes. These are required up front (and in dependency order) because
// the codebase wires its class hierarchy through globals — requiring Entity and
// Character first guarantees those globals exist before Mob/Npc/Player/Item are
// loaded, both here and inside the collaborator modules below.
require("./entity");
require("./character");
var Mob = require('./mob'),
    Map = require('./map'),
    Npc = require('./npc'),
    Player = require('./player'),
    Item = require('./item'),
    MobArea = require('./mobarea'),
    ChestArea = require('./chestarea'),
    Chest = require('./chest'),
    Messages = require('./message'),
    Properties = require("./properties"),
    Utils = require("./utils"),
    Types = require("../../shared/js/gametypes");

// Infrastructure layers. The World orchestrates these collaborators rather than
// owning their state directly:
//   - ConnectionManager (connection layer): outgoing queues + the transport.
//   - EntityManager      (world layer):      entities and their typed indexes.
//   - GroupManager       (world layer):      zone groups and membership.
//   - Broadcaster        (broadcast layer):  group-aware message fan-out.
var ConnectionManager = require('./connection'),
    EntityManager = require('./entitymanager'),
    GroupManager = require('./groupmanager'),
    Broadcaster = require('./broadcaster');

// ======= GAME SERVER ========

/**
 * The World is the game-rules orchestrator. It no longer holds the entity, queue
 * and zone collections itself — those live in the layers above. What stays here
 * is the wiring between layers and the gameplay flows that cut across them:
 * the player lifecycle, combat, drops, area population and the update loop.
 *
 * The public method surface is kept stable so the entity classes (player.js,
 * mob areas, etc.) keep talking to `world.*` exactly as before; most of those
 * methods are now thin delegations to the relevant layer.
 */
module.exports = World = cls.Class.extend({
    init: function(id, maxPlayers, websocketServer) {
        var self = this;

        this.id = id;
        this.maxPlayers = maxPlayers;
        this.ups = 50;

        this.map = null;

        // The entity and connection layers have no dependency on the map and can
        // be created immediately. The group and broadcast layers need the map, so
        // they are wired up in run() once the Map object exists.
        this.entityManager = new EntityManager();
        this.connection = new ConnectionManager(websocketServer);
        this.groupManager = null;
        this.broadcaster = null;

        // Area definitions are gameplay objects (spawn rules), not per-entity
        // indexes, so they stay on the world alongside the rules that use them.
        this.mobAreas = [];
        this.chestAreas = [];

        // Cross-cutting population counter, read by the load balancer in main.js.
        this.playerCount = 0;

        this.onPlayerConnect(function(player) {
            player.onRequestPosition(function() {
                if(player.lastCheckpoint) {
                    return player.lastCheckpoint.getRandomPosition();
                } else {
                    return self.map.getRandomStartingPosition();
                }
            });
        });

        this.onPlayerEnter(function(player) {
            log.info(player.name + " has joined "+ self.id);

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

        // Called when an entity is attacked by another entity
        this.onEntityAttack(function(attacker) {
            var target = self.getEntityById(attacker.target);
            if(target && attacker.type === "mob") {
                var pos = self.findPositionNextTo(attacker, target);
                self.moveEntity(attacker, pos.x, pos.y);
            }
        });

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

    run: function(mapFilePath) {
        var self = this;

        this.map = new Map(mapFilePath);

        // The group and broadcast layers depend on the map, so they are wired up
        // here rather than in init().
        this.groupManager = new GroupManager(this.map);
        this.broadcaster = new Broadcaster(this.map, this.groupManager, this.connection, this.entityManager);

        this.map.ready(function() {
            self.groupManager.build();

            self.map.generateCollisionGrid();

            // Populate all mob "roaming" areas
            _.each(self.map.mobAreas, function(a) {
                var area = new MobArea(a.id, a.nb, a.type, a.x, a.y, a.width, a.height, self);
                area.spawnMobs();
                area.onEmpty(self.handleEmptyMobArea.bind(self, area));

                self.mobAreas.push(area);
            });

            // Create all chest areas
            _.each(self.map.chestAreas, function(a) {
                var area = new ChestArea(a.id, a.x, a.y, a.w, a.h, a.tx, a.ty, a.i, self);
                self.chestAreas.push(area);
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
            _.each(self.chestAreas, function(area) {
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

        log.info(""+this.id+" created (capacity: "+this.maxPlayers+" players).");
    },

    setUpdatesPerSecond: function(ups) {
        this.ups = ups;
    },

    // ======= Lifecycle hooks =======

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

    /**
     * Entry point for a brand new connection. Owning Player construction here
     * keeps main.js from having to know about the Player class or reach into the
     * world's connect callback directly.
     */
    connectPlayer: function(connection) {
        if(this.connect_callback) {
            this.connect_callback(new Player(connection, this));
        }
    },

    // ======= Broadcast layer (delegation) =======

    pushRelevantEntityListTo: function(player) {
        var entities;

        if(player && this.groupManager.hasGroup(player.group)) {
            entities = _.keys(this.groupManager.getGroup(player.group).entities);
            entities = _.reject(entities, function(id) { return id == player.id; });
            entities = _.map(entities, function(id) { return parseInt(id); });
            if(entities) {
                this.pushToPlayer(player, new Messages.List(entities));
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

        log.debug("Pushed "+_.size(ids)+" new spawns to "+player.id);
    },

    pushToPlayer: function(player, message) {
        this.connection.pushToPlayer(player, message);
    },

    pushToGroup: function(groupId, message, ignoredPlayer) {
        this.broadcaster.pushToGroup(groupId, message, ignoredPlayer);
    },

    pushToAdjacentGroups: function(groupId, message, ignoredPlayer) {
        this.broadcaster.pushToAdjacentGroups(groupId, message, ignoredPlayer);
    },

    pushToPreviousGroups: function(player, message) {
        this.broadcaster.pushToPreviousGroups(player, message);
    },

    pushBroadcast: function(message, ignoredPlayer) {
        this.connection.broadcast(message, ignoredPlayer);
    },

    // ======= Connection layer (delegation) =======

    processQueues: function() {
        this.connection.flush();
    },

    // ======= World layer: entities =======

    addEntity: function(entity) {
        this.entityManager.add(entity);
        this.handleEntityGroupMembership(entity);
    },

    removeEntity: function(entity) {
        this.entityManager.remove(entity);

        if(entity.type === "mob") {
            this.clearMobAggroLink(entity);
            this.clearMobHateLinks(entity);
        }

        entity.destroy();
        this.groupManager.removeFromGroups(entity);
        log.debug("Removed "+ Types.getKindAsString(entity.kind) +" : "+ entity.id);
    },

    addPlayer: function(player) {
        this.addEntity(player);
        this.connection.addQueue(player.id);

        //log.info("Added player : " + player.id);
    },

    removePlayer: function(player) {
        player.broadcast(player.despawn());
        this.removeEntity(player);
        this.connection.removeQueue(player.id);
    },

    addMob: function(mob) {
        this.addEntity(mob);
    },

    addNpc: function(kind, x, y) {
        var npc = new Npc('8'+x+''+y, kind, x, y);
        this.addEntity(npc);

        return npc;
    },

    addItem: function(item) {
        this.addEntity(item);

        return item;
    },

    createItem: function(kind, x, y) {
        var id = this.entityManager.nextItemId(),
            item = null;

        if(kind === Types.Entities.CHEST) {
            item = new Chest(id, x, y);
        } else {
            item = new Item(id, kind, x, y);
        }
        return item;
    },

    createChest: function(x, y, items) {
        var chest = this.createItem(Types.Entities.CHEST, x, y);
        chest.setItems(items);
        return chest;
    },

    addStaticItem: function(item) {
        item.isStatic = true;
        item.onRespawn(this.addStaticItem.bind(this, item));

        return this.addItem(item);
    },

    addItemFromChest: function(kind, x, y) {
        var item = this.createItem(kind, x, y);
        item.isFromChest = true;

        return this.addItem(item);
    },

    getEntityById: function(id) {
        if(this.entityManager.has(id)) {
            return this.entityManager.get(id);
        } else {
            log.error("Unknown entity : " + id);
        }
    },

    getPlayerCount: function() {
        return this.entityManager.count("players");
    },

    forEachEntity: function(callback) {
        this.entityManager.forEach(callback);
    },

    forEachPlayer: function(callback) {
        this.entityManager.forEachIn("players", callback);
    },

    forEachMob: function(callback) {
        this.entityManager.forEachIn("mobs", callback);
    },

    forEachCharacter: function(callback) {
        this.forEachPlayer(callback);
        this.forEachMob(callback);
    },

    despawn: function(entity) {
        this.pushToAdjacentGroups(entity.group, entity.despawn());

        if(this.entityManager.has(entity.id)) {
            this.removeEntity(entity);
        }
    },

    spawnStaticEntities: function() {
        var self = this,
            count = 0;

        _.each(this.map.staticEntities, function(kindName, tid) {
            var kind = Types.getKindFromString(kindName),
                pos = self.map.tileIndexToGridPosition(tid);

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

    isValidPosition: function(x, y) {
        if(this.map && _.isNumber(x) && _.isNumber(y) && !this.map.isOutOfBounds(x, y) && !this.map.isColliding(x, y)) {
            return true;
        }
        return false;
    },

    // ======= World layer: zone groups (delegation + spawn draining) =======

    handleEntityGroupMembership: function(entity) {
        return this.groupManager.handleEntityGroupMembership(entity);
    },

    processGroups: function() {
        var self = this;

        if(this.groupManager.zoneGroupsReady) {
            this.groupManager.forEachGroup(function(id) {
                var group = self.groupManager.getGroup(id);
                if(group.incoming.length > 0) {
                    _.each(group.incoming, function(entity) {
                        if(entity instanceof Player) {
                            self.pushToGroup(id, new Messages.Spawn(entity), entity.id);
                        } else {
                            self.pushToGroup(id, new Messages.Spawn(entity));
                        }
                    });
                    group.incoming = [];
                }
            });
        }
    },

    moveEntity: function(entity, x, y) {
        if(entity) {
            entity.setPosition(x, y);
            this.handleEntityGroupMembership(entity);
        }
    },

    // ======= Gameplay: combat =======

    /**
     * The mob will no longer be registered as an attacker of its current target.
     */
    clearMobAggroLink: function(mob) {
        var player = null;
        if(mob.target) {
            player = this.getEntityById(mob.target);
            if(player) {
                player.removeAttacker(mob);
            }
        }
    },

    clearMobHateLinks: function(mob) {
        var self = this;
        if(mob) {
            _.each(mob.hatelist, function(obj) {
                var player = self.getEntityById(obj.id);
                if(player) {
                    player.removeHater(mob);
                }
            });
        }
    },

    handleMobHate: function(mobId, playerId, hatePoints) {
        var mob = this.getEntityById(mobId),
            player = this.getEntityById(playerId),
            mostHated;

        if(player && mob) {
            mob.increaseHateFor(playerId, hatePoints);
            player.addHater(mob);

            if(mob.hitPoints > 0) { // only choose a target if still alive
                this.chooseMobTarget(mob);
            }
        }
    },

    chooseMobTarget: function(mob, hateRank) {
        var player = this.getEntityById(mob.getHatedPlayerId(hateRank));

        // If the mob is not already attacking the player, create an attack link between them.
        if(player && !(mob.id in player.attackers)) {
            this.clearMobAggroLink(mob);

            player.addAttacker(mob);
            mob.setTarget(player);

            this.broadcastAttacker(mob);
            log.debug(mob.id + " is now attacking " + player.id);
        }
    },

    broadcastAttacker: function(character) {
        if(character) {
            this.pushToAdjacentGroups(character.group, character.attack(), character.id);
        }
        if(this.attack_callback) {
            this.attack_callback(character);
        }
    },

    handleHurtEntity: function(entity, attacker, damage) {
        var self = this;

        if(entity.type === 'player') {
            // A player is only aware of his own hitpoints
            this.pushToPlayer(entity, entity.health());
        }

        if(entity.type === 'mob') {
            // Let the mob's attacker (player) know how much damage was inflicted
            this.pushToPlayer(attacker, new Messages.Damage(entity, damage));
        }

        // If the entity is about to die
        if(entity.hitPoints <= 0) {
            if(entity.type === "mob") {
                var mob = entity,
                    item = this.getDroppedItem(mob);

                this.pushToPlayer(attacker, new Messages.Kill(mob));
                this.pushToAdjacentGroups(mob.group, mob.despawn()); // Despawn must be enqueued before the item drop
                if(item) {
                    this.pushToAdjacentGroups(mob.group, mob.drop(item));
                    this.handleItemDespawn(item);
                }
            }

            if(entity.type === "player") {
                this.handlePlayerVanish(entity);
                this.pushToAdjacentGroups(entity.group, entity.despawn());
            }

            this.removeEntity(entity);
        }
    },

    handlePlayerVanish: function(player) {
        var self = this,
            previousAttackers = [];

        // When a player dies or teleports, all of his attackers go and attack their second most hated player.
        player.forEachAttacker(function(mob) {
            previousAttackers.push(mob);
            self.chooseMobTarget(mob, 2);
        });

        _.each(previousAttackers, function(mob) {
            player.removeAttacker(mob);
            mob.clearTarget();
            mob.forgetPlayer(player.id, 1000);
        });

        this.handleEntityGroupMembership(player);
    },

    onMobMoveCallback: function(mob) {
        this.pushToAdjacentGroups(mob.group, new Messages.Move(mob));
        this.handleEntityGroupMembership(mob);
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

    // ======= Gameplay: drops, items & areas =======

    getDroppedItem: function(mob) {
        var kind = Types.getKindAsString(mob.kind),
            drops = Properties[kind].drops,
            v = Utils.random(100),
            p = 0,
            item = null;

        for(var itemName in drops) {
            var percentage = drops[itemName];

            p += percentage;
            if(v <= p) {
                item = this.addItem(this.createItem(Types.getKindFromString(itemName), mob.x, mob.y));
                break;
            }
        }

        return item;
    },

    handleItemDespawn: function(item) {
        var self = this;

        if(item) {
            item.handleDespawn({
                beforeBlinkDelay: 10000,
                blinkCallback: function() {
                    self.pushToAdjacentGroups(item.group, new Messages.Blink(item));
                },
                blinkingDuration: 4000,
                despawnCallback: function() {
                    self.pushToAdjacentGroups(item.group, new Messages.Destroy(item));
                    self.removeEntity(item);
                }
            });
        }
    },

    handleEmptyMobArea: function(area) {

    },

    handleEmptyChestArea: function(area) {
        if(area) {
            var chest = this.addItem(this.createChest(area.chestX, area.chestY, area.items));
            this.handleItemDespawn(chest);
        }
    },

    handleOpenedChest: function(chest, player) {
        this.pushToAdjacentGroups(chest.group, chest.despawn());
        this.removeEntity(chest);

        var kind = chest.getRandomItem();
        if(kind) {
            var item = this.addItemFromChest(kind, chest.x, chest.y);
            this.handleItemDespawn(item);
        }
    },

    tryAddingMobToChestArea: function(mob) {
        _.each(this.chestAreas, function(area) {
            if(area.contains(mob)) {
                area.addToArea(mob);
            }
        });
    },

    // ======= Population =======

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

    updatePopulation: function(totalPlayers) {
        this.pushBroadcast(new Messages.Population(this.playerCount, totalPlayers ? totalPlayers : this.playerCount));
    }
});
