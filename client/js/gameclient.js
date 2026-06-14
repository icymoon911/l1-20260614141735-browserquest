
/**
 * GameClient — Network facade for the game.
 *
 * This is the SINGLE entry point for all client ↔ server communication.
 *
 * Architecture (top = wire, bottom = game logic):
 *
 *   WebSocket raw bytes
 *        │
 *        ▼
 *   Connection            (connection.js)
 *     │  Transport lifecycle, "go"/"timeout" protocol, send guard
 *     │
 *     ▼ raw data string
 *   MessageHandler        (messagehandler.js)
 *     │  Decode (JSON/BISON), validate, route by message type
 *     │
 *     ▼ decoded array → registered handler function
 *   GameClient            (this file)
 *     │  Parse array → named fields → fire semantic callback
 *     │
 *     ▼ semantic callback(name, args...)
 *   Game                  (game.js)
 *        Game logic: entities, combat, UI, achievements
 *
 * Handler categories (see MessageHandler.Category):
 *
 *   CONNECTION — WELCOME, LIST
 *   ENTITY     — SPAWN, DESPAWN, DESTROY, MOVE, LOOTMOVE, TELEPORT,
 *                BLINK, DROP, EQUIP
 *   COMBAT     — ATTACK, DAMAGE
 *   PLAYER     — HEALTH, HP, KILL
 *   UI         — CHAT, POPULATION
 *
 * Wire protocol: UNCHANGED.  All Types.Messages.* type IDs and array
 * field layouts are identical to the original implementation.
 */
define(['player', 'entityfactory', 'lib/bison', 'connection', 'messagehandler'],
function(Player, EntityFactory, BISON, Connection, MessageHandler) {

    var Category = MessageHandler.Category;

    var GameClient = Class.extend({
        init: function(host, port) {
            this.host = host;
            this.port = port;

            // --- Layer 1: Transport ---
            this.connection = new Connection();

            // --- Layer 2: Message dispatch ---
            this.messageHandler = new MessageHandler();

            // --- Semantic callbacks (set by Game via on* methods) ---
            this._callbacks = {};

            // Wire: Connection → MessageHandler
            this.connection.onMessage(
                this.messageHandler.handleMessage.bind(this.messageHandler)
            );

            // Register all inbound message handlers
            this._registerHandlers();
        },

        // ===================================================================
        // Listener enable / disable  (delegates to MessageHandler)
        // ===================================================================

        enable: function() {
            this.messageHandler.enable();
        },

        disable: function() {
            this.messageHandler.disable();
        },

        // ===================================================================
        // Connection lifecycle
        // ===================================================================

        /**
         * Connect to the server.
         *
         * @param {Boolean} [dispatcherMode]  If true, use the dispatcher
         *        protocol (front-end load-balancer proxy).
         */
        connect: function(dispatcherMode) {
            var self = this;

            // Make host/port available to Connection for log messages
            this.connection.host = this.host;
            this.connection.port = this.port;

            // Forward transport-level events to semantic callbacks
            this.connection.onReady(function() {
                self._fire('connected');
            });

            this.connection.onClose(function(message) {
                self._fire('disconnected', message);
            });

            this.connection.onDispatched(function(host, port) {
                self._fire('dispatched', host, port);
            });

            this.connection.connect(this.host, this.port, dispatcherMode);
        },

        // ===================================================================
        // Outbound messages  (send*)
        // ===================================================================

        sendMessage: function(json) {
            var data;
            if(this.messageHandler.useBison) {
                data = BISON.encode(json);
            } else {
                data = JSON.stringify(json);
            }
            this.connection.send(data);
        },

        sendHello: function(player) {
            this.sendMessage([Types.Messages.HELLO,
                              player.name,
                              Types.getKindFromString(player.getSpriteName()),
                              Types.getKindFromString(player.getWeaponName())]);
        },

        sendMove: function(x, y) {
            this.sendMessage([Types.Messages.MOVE, x, y]);
        },

        sendLootMove: function(item, x, y) {
            this.sendMessage([Types.Messages.LOOTMOVE, x, y, item.id]);
        },

        sendAggro: function(mob) {
            this.sendMessage([Types.Messages.AGGRO, mob.id]);
        },

        sendAttack: function(mob) {
            this.sendMessage([Types.Messages.ATTACK, mob.id]);
        },

        sendHit: function(mob) {
            this.sendMessage([Types.Messages.HIT, mob.id]);
        },

        sendHurt: function(mob) {
            this.sendMessage([Types.Messages.HURT, mob.id]);
        },

        sendChat: function(text) {
            this.sendMessage([Types.Messages.CHAT, text]);
        },

        sendLoot: function(item) {
            this.sendMessage([Types.Messages.LOOT, item.id]);
        },

        sendTeleport: function(x, y) {
            this.sendMessage([Types.Messages.TELEPORT, x, y]);
        },

        sendWho: function(ids) {
            ids.unshift(Types.Messages.WHO);
            this.sendMessage(ids);
        },

        sendZone: function() {
            this.sendMessage([Types.Messages.ZONE]);
        },

        sendOpen: function(chest) {
            this.sendMessage([Types.Messages.OPEN, chest.id]);
        },

        sendCheck: function(id) {
            this.sendMessage([Types.Messages.CHECK, id]);
        },

        // ===================================================================
        // Inbound handler registration
        // ===================================================================

        /**
         * Register all inbound message handlers on the MessageHandler.
         *
         * Each handler:  raw array → extract fields → fire semantic callback.
         * Grouped by category for readability.
         *
         * NOTE: SPAWN_BATCH is intentionally NOT registered — the original
         * code referenced Types.Messages.SPAWN_BATCH which does not exist
         * in the protocol.  Batch messages are handled transparently by
         * MessageHandler._dispatchBatch via nested array detection.
         */
        _registerHandlers: function() {
            var self = this;

            // ---------------------------------------------------------------
            // CONNECTION — Handshake, session lifecycle
            // ---------------------------------------------------------------

            this.messageHandler.register(
                Types.Messages.WELCOME,
                function(data) {
                    var id   = data[1],
                        name = data[2],
                        x    = data[3],
                        y    = data[4],
                        hp   = data[5];
                    self._fire('welcome', id, name, x, y, hp);
                },
                Category.CONNECTION
            );

            this.messageHandler.register(
                Types.Messages.LIST,
                function(data) {
                    // data[0] = LIST type; rest = entity id list
                    var list = data.slice(1);
                    self._fire('list', list);
                },
                Category.CONNECTION
            );

            // ---------------------------------------------------------------
            // ENTITY — Spawn / despawn / destroy
            // ---------------------------------------------------------------

            this.messageHandler.register(
                Types.Messages.SPAWN,
                function(data) { self._handleSpawn(data); },
                Category.ENTITY
            );

            this.messageHandler.register(
                Types.Messages.DESPAWN,
                function(data) {
                    self._fire('despawnEntity', data[1]);
                },
                Category.ENTITY
            );

            this.messageHandler.register(
                Types.Messages.DESTROY,
                function(data) {
                    self._fire('entityDestroy', data[1]);
                },
                Category.ENTITY
            );

            // ---------------------------------------------------------------
            // ENTITY — Movement
            // ---------------------------------------------------------------

            this.messageHandler.register(
                Types.Messages.MOVE,
                function(data) {
                    var id = data[1], x = data[2], y = data[3];
                    self._fire('entityMove', id, x, y);
                },
                Category.ENTITY
            );

            this.messageHandler.register(
                Types.Messages.LOOTMOVE,
                function(data) {
                    var id = data[1], item = data[2];
                    self._fire('playerMoveToItem', id, item);
                },
                Category.ENTITY
            );

            this.messageHandler.register(
                Types.Messages.TELEPORT,
                function(data) {
                    var id = data[1], x = data[2], y = data[3];
                    self._fire('playerTeleport', id, x, y);
                },
                Category.ENTITY
            );

            this.messageHandler.register(
                Types.Messages.BLINK,
                function(data) {
                    self._fire('itemBlink', data[1]);
                },
                Category.ENTITY
            );

            // ---------------------------------------------------------------
            // ENTITY — State changes (drop, equip)
            // ---------------------------------------------------------------

            this.messageHandler.register(
                Types.Messages.DROP,
                function(data) {
                    var mobId  = data[1],
                        id     = data[2],
                        kind   = data[3],
                        item   = EntityFactory.createEntity(kind, id);

                    item.wasDropped = true;
                    item.playersInvolved = data[4];

                    self._fire('dropItem', item, mobId);
                },
                Category.ENTITY
            );

            this.messageHandler.register(
                Types.Messages.EQUIP,
                function(data) {
                    var id       = data[1],
                        itemKind = data[2];
                    self._fire('playerEquipItem', id, itemKind);
                },
                Category.ENTITY
            );

            // ---------------------------------------------------------------
            // COMBAT — Attack, damage
            // ---------------------------------------------------------------

            this.messageHandler.register(
                Types.Messages.ATTACK,
                function(data) {
                    var attacker = data[1],
                        target   = data[2];
                    self._fire('entityAttack', attacker, target);
                },
                Category.COMBAT
            );

            this.messageHandler.register(
                Types.Messages.DAMAGE,
                function(data) {
                    var id  = data[1],
                        dmg = data[2];
                    self._fire('playerDamageMob', id, dmg);
                },
                Category.COMBAT
            );

            // ---------------------------------------------------------------
            // PLAYER — Health, hit points, kill
            // ---------------------------------------------------------------

            this.messageHandler.register(
                Types.Messages.HEALTH,
                function(data) {
                    var points  = data[1],
                        isRegen = data[2] ? true : false;
                    self._fire('playerChangeHealth', points, isRegen);
                },
                Category.PLAYER
            );

            this.messageHandler.register(
                Types.Messages.HP,
                function(data) {
                    var maxHp = data[1];
                    self._fire('playerChangeMaxHitPoints', maxHp);
                },
                Category.PLAYER
            );

            this.messageHandler.register(
                Types.Messages.KILL,
                function(data) {
                    var mobKind = data[1];
                    self._fire('playerKillMob', mobKind);
                },
                Category.PLAYER
            );

            // ---------------------------------------------------------------
            // UI — Chat, population
            // ---------------------------------------------------------------

            this.messageHandler.register(
                Types.Messages.CHAT,
                function(data) {
                    var id   = data[1],
                        text = data[2];
                    self._fire('chatMessage', id, text);
                },
                Category.UI
            );

            this.messageHandler.register(
                Types.Messages.POPULATION,
                function(data) {
                    var worldPlayers = data[1],
                        totalPlayers = data[2];
                    self._fire('populationChange', worldPlayers, totalPlayers);
                },
                Category.UI
            );
        },

        // ===================================================================
        // SPAWN handler (complex — routes by entity kind)
        // ===================================================================

        /**
         * Handle SPAWN messages.
         * Creates the entity via EntityFactory and fires the appropriate
         * typed callback: spawnItem, spawnChest, or spawnCharacter.
         */
        _handleSpawn: function(data) {
            var id   = data[1],
                kind = data[2],
                x    = data[3],
                y    = data[4];

            if(Types.isItem(kind)) {
                var item = EntityFactory.createEntity(kind, id);
                this._fire('spawnItem', item, x, y);
            }
            else if(Types.isChest(kind)) {
                var chest = EntityFactory.createEntity(kind, id);
                this._fire('spawnChest', chest, x, y);
            }
            else {
                var name, orientation, target, weapon, armor;

                if(Types.isPlayer(kind)) {
                    name        = data[5];
                    orientation = data[6];
                    armor       = data[7];
                    weapon      = data[8];
                    if(data.length > 9) {
                        target = data[9];
                    }
                }
                else if(Types.isMob(kind)) {
                    orientation = data[5];
                    if(data.length > 6) {
                        target = data[6];
                    }
                }

                var character = EntityFactory.createEntity(kind, id, name);

                if(character instanceof Player) {
                    character.weaponName = Types.getKindAsString(weapon);
                    character.spriteName = Types.getKindAsString(armor);
                }

                this._fire('spawnCharacter', character, x, y, orientation, target);
            }
        },

        // ===================================================================
        // Callback infrastructure
        // ===================================================================

        /**
         * Store a semantic callback.
         */
        _setCallback: function(name, fn) {
            this._callbacks[name] = fn;
        },

        /**
         * Fire a semantic callback by name with the given arguments.
         */
        _fire: function(name) {
            var fn = this._callbacks[name];
            if(fn) {
                fn.apply(null, Array.prototype.slice.call(arguments, 1));
            }
        },

        // ===================================================================
        // Semantic callback registration  (called by Game)
        // ===================================================================

        // --- Connection lifecycle ---
        onDispatched:    function(cb) { this._setCallback('dispatched', cb); },
        onConnected:     function(cb) { this._setCallback('connected', cb); },
        onDisconnected:  function(cb) { this._setCallback('disconnected', cb); },

        // --- CONNECTION category ---
        onWelcome:       function(cb) { this._setCallback('welcome', cb); },
        onEntityList:    function(cb) { this._setCallback('list', cb); },

        // --- ENTITY category ---
        onSpawnCharacter:   function(cb) { this._setCallback('spawnCharacter', cb); },
        onSpawnItem:        function(cb) { this._setCallback('spawnItem', cb); },
        onSpawnChest:       function(cb) { this._setCallback('spawnChest', cb); },
        onDespawnEntity:    function(cb) { this._setCallback('despawnEntity', cb); },
        onEntityDestroy:    function(cb) { this._setCallback('entityDestroy', cb); },
        onEntityMove:       function(cb) { this._setCallback('entityMove', cb); },
        onPlayerMoveToItem: function(cb) { this._setCallback('playerMoveToItem', cb); },
        onPlayerTeleport:   function(cb) { this._setCallback('playerTeleport', cb); },
        onItemBlink:        function(cb) { this._setCallback('itemBlink', cb); },
        onDropItem:         function(cb) { this._setCallback('dropItem', cb); },
        onPlayerEquipItem:  function(cb) { this._setCallback('playerEquipItem', cb); },

        // --- COMBAT category ---
        onEntityAttack:     function(cb) { this._setCallback('entityAttack', cb); },
        onPlayerDamageMob:  function(cb) { this._setCallback('playerDamageMob', cb); },

        // --- PLAYER category ---
        onPlayerChangeHealth:      function(cb) { this._setCallback('playerChangeHealth', cb); },
        onPlayerChangeMaxHitPoints:function(cb) { this._setCallback('playerChangeMaxHitPoints', cb); },
        onPlayerKillMob:           function(cb) { this._setCallback('playerKillMob', cb); },

        // --- UI category ---
        onChatMessage:      function(cb) { this._setCallback('chatMessage', cb); },
        onPopulationChange: function(cb) { this._setCallback('populationChange', cb); }
    });

    return GameClient;
});
