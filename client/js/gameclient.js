
define(['player', 'entityfactory', 'lib/bison'], function(Player, EntityFactory, BISON) {

    /**
     * GameClient owns everything between the WebSocket and the rest of the game.
     *
     * The flow reads top to bottom:
     *
     *   1. CONNECTION LIFECYCLE  - open the socket, watch open/close/error and the
     *                              dispatcher reply; turn raw socket events into
     *                              "connected" / "disconnected" notifications.
     *   2. INCOMING PIPELINE     - decode a frame, split batches, and route each
     *                              action through the handler registry. This is the
     *                              single door every server message comes through.
     *   3. HANDLER REGISTRY      - a data table mapping each wire message type to the
     *                              decoder that knows its layout. Grouped by layer so
     *                              "which messages touch entities / the player / the
     *                              UI" is visible at a glance. Adding a message type
     *                              means adding one row here plus its decoder.
     *   4. MESSAGE DECODERS      - pull named fields out of the raw array and emit a
     *                              named event. They never call game code directly.
     *   5. SUBSCRIPTION API      - the on* methods register a single consumer per
     *                              event. dispatch() is the only place a consumer
     *                              callback ever fires.
     *   6. OUTGOING MESSAGES     - the send* builders that serialize to the wire.
     *
     * The wire protocol (message type numbers in Types.Messages and the array layout
     * of each message) is fixed and shared with the server - decoders and builders
     * here must keep producing/consuming those exact shapes.
     */

    // Control frames the server sends outside the array-based message protocol.
    var ControlFrame = {
        GO:      "go",      // handshake is ready, the client may start
        TIMEOUT: "timeout"  // the connection is about to be closed for inactivity
    };

    // Status field of a dispatcher reply (when connecting through the dispatcher).
    var DispatcherStatus = {
        OK:   "OK",
        FULL: "FULL"
    };

    // Catalogue of every event a consumer can subscribe to, grouped by the layer
    // the message ultimately drives. The prefix makes the layer obvious at each
    // dispatch()/on* site, so a single line tells you what kind of update it is.
    var Events = {
        // Connection lifecycle
        DISPATCHED:      "conn:dispatched",
        CONNECTED:       "conn:connected",
        DISCONNECTED:    "conn:disconnected",

        // The local player's own state
        WELCOME:         "player:welcome",
        HEALTH:          "player:health",
        MAX_HITPOINTS:   "player:max-hitpoints",

        // World entities: lifecycle, movement and appearance
        SPAWN_CHARACTER: "entity:spawn-character",
        SPAWN_ITEM:      "entity:spawn-item",
        SPAWN_CHEST:     "entity:spawn-chest",
        DESPAWN:         "entity:despawn",
        DESTROY:         "entity:destroy",
        MOVE:            "entity:move",
        LOOT_MOVE:       "entity:loot-move",
        ATTACK:          "entity:attack",
        TELEPORT:        "entity:teleport",
        EQUIP:           "entity:equip",
        BLINK:           "entity:blink",
        DROP:            "entity:drop",
        LIST:            "entity:list",

        // HUD, chat and notifications
        CHAT:            "ui:chat",
        POPULATION:      "ui:population",
        DAMAGE:          "ui:damage-mob",
        KILL:            "ui:kill-mob"
    };

    var GameClient = Class.extend({
        init: function(host, port) {
            this.connection = null;
            this.host = host;
            this.port = port;

            this.isListening = false;
            this.isTimeout = false;
            this.useBison = false;

            // event name -> single consumer callback. Registered by the on* methods,
            // fired by dispatch(). The one place subscriptions live.
            this.listeners = {};

            // wire message type -> decoder method. Built in initHandlers().
            this.handlers = [];
            this.initHandlers();

            this.enable();
        },

        enable: function() {
            this.isListening = true;
        },

        disable: function() {
            this.isListening = false;
        },

        // --- Subscription backbone ------------------------------------------------
        // The single channel between "a message was decoded" and "the game reacts".
        // on* methods bind here; decoders fire through dispatch().

        bind: function(event, callback) {
            this.listeners[event] = callback;
        },

        dispatch: function(event) {
            var callback = this.listeners[event];

            if(callback) {
                callback.apply(this, Array.prototype.slice.call(arguments, 1));
            }
        },

        // === 1. CONNECTION LIFECYCLE ==============================================

        connect: function(dispatcherMode) {
            var url = "ws://"+ this.host +":"+ this.port +"/";

            log.info("Trying to connect to server : "+url);

            this.connection = this.createSocket(url);

            if(dispatcherMode) {
                this.listenToDispatcher();
            } else {
                this.listenToGameServer();
            }
        },

        createSocket: function(url) {
            if(window.MozWebSocket) {
                return new MozWebSocket(url);
            }
            return new WebSocket(url);
        },

        // Dispatcher mode: the only thing we expect back is a routing reply telling
        // us which game server to actually connect to (or that the world is full).
        listenToDispatcher: function() {
            var self = this;

            this.connection.onmessage = function(e) {
                self.receiveDispatcherReply(e.data);
            };
        },

        receiveDispatcherReply: function(data) {
            var reply = JSON.parse(data);

            if(reply.status === DispatcherStatus.OK) {
                this.dispatch(Events.DISPATCHED, reply.host, reply.port);
            } else if(reply.status === DispatcherStatus.FULL) {
                alert("BrowserQuest is currently at maximum player population. Please retry later.");
            } else {
                alert("Unknown error while connecting to BrowserQuest.");
            }
        },

        // Game-server mode: wire up the full socket lifecycle.
        listenToGameServer: function() {
            var self = this;

            this.connection.onopen = function() {
                log.info("Connected to server "+self.host+":"+self.port);
            };

            this.connection.onmessage = function(e) {
                self.onSocketData(e.data);
            };

            this.connection.onerror = function(e) {
                log.error(e, true);
            };

            this.connection.onclose = function() {
                self.onSocketClose();
            };
        },

        onSocketData: function(data) {
            // Control frames are bare strings and bypass the message protocol.
            if(data === ControlFrame.GO) {
                this.dispatch(Events.CONNECTED);
                return;
            }
            if(data === ControlFrame.TIMEOUT) {
                this.isTimeout = true;
                return;
            }

            this.receiveMessage(data);
        },

        onSocketClose: function() {
            log.debug("Connection closed");
            $('#container').addClass('error');

            // A close that follows a timeout frame is an inactivity kick; anything
            // else is an unexpected drop. Either way the consumer (if any) decides
            // what to show - dispatch is a no-op when nobody is listening.
            if(this.isTimeout) {
                this.dispatch(Events.DISCONNECTED, "You have been disconnected for being inactive for too long");
            } else {
                this.dispatch(Events.DISCONNECTED, "The connection to BrowserQuest has been lost");
            }
        },

        // === 2. INCOMING PIPELINE =================================================
        // Every server message enters here. Decode -> split batch -> route action.

        receiveMessage: function(message) {
            var data;

            // Messages that arrive while we are not listening (e.g. after the local
            // player has died and the socket is being torn down) are dropped.
            if(!this.isListening) {
                return;
            }

            data = this.useBison ? BISON.decode(message) : JSON.parse(message);

            log.debug("data: " + message);

            if(!(data instanceof Array)) {
                // Anything that is not an action array is malformed for this layer.
                log.error("Discarding non-array message: " + message);
                return;
            }

            if(data[0] instanceof Array) {
                this.receiveActionBatch(data);  // a batch: an array of actions
            } else {
                this.receiveAction(data);       // a single action
            }
        },

        receiveActionBatch: function(actions) {
            var self = this;

            _.each(actions, function(action) {
                self.receiveAction(action);
            });
        },

        receiveAction: function(data) {
            var action = data[0],
                handler = this.handlers[action];

            if(handler && _.isFunction(handler)) {
                handler.call(this, data);
            } else {
                log.error("Unknown action : " + action);
            }
        },

        // === 3. HANDLER REGISTRY ==================================================
        // Wire message type -> decoder. Grouped by the layer each message drives so
        // the routing table doubles as a map of what touches what.

        initHandlers: function() {
            var M = Types.Messages,
                h = this.handlers;

            // Local player state
            h[M.WELCOME]    = this.receiveWelcome;
            h[M.HEALTH]     = this.receiveHealth;
            h[M.HP]         = this.receiveHitPoints;

            // World entities: lifecycle, movement, appearance
            h[M.SPAWN]      = this.receiveSpawn;
            h[M.DESPAWN]    = this.receiveDespawn;
            h[M.DESTROY]    = this.receiveDestroy;
            h[M.MOVE]       = this.receiveMove;
            h[M.LOOTMOVE]   = this.receiveLootMove;
            h[M.ATTACK]     = this.receiveAttack;
            h[M.TELEPORT]   = this.receiveTeleport;
            h[M.EQUIP]      = this.receiveEquipItem;
            h[M.DROP]       = this.receiveDrop;
            h[M.BLINK]      = this.receiveBlink;
            h[M.LIST]       = this.receiveList;

            // HUD, chat and notifications
            h[M.CHAT]       = this.receiveChat;
            h[M.POPULATION] = this.receivePopulation;
            h[M.DAMAGE]     = this.receiveDamage;
            h[M.KILL]       = this.receiveKill;
        },

        // === 4. MESSAGE DECODERS ==================================================
        // Each decoder reads the fixed wire layout into named fields and emits a
        // named event. They do not reach into game state - that is the consumer's
        // job, registered via the matching on* method below.

        // --- Local player state ---

        receiveWelcome: function(data) {
            var id = data[1],
                name = data[2],
                x = data[3],
                y = data[4],
                hp = data[5];

            this.dispatch(Events.WELCOME, id, name, x, y, hp);
        },

        receiveHealth: function(data) {
            var points = data[1],
                isRegen = data[2] ? true : false;

            this.dispatch(Events.HEALTH, points, isRegen);
        },

        receiveHitPoints: function(data) {
            var maxHp = data[1];

            this.dispatch(Events.MAX_HITPOINTS, maxHp);
        },

        // --- World entities ---

        receiveSpawn: function(data) {
            var id = data[1],
                kind = data[2],
                x = data[3],
                y = data[4];

            if(Types.isItem(kind)) {
                var item = EntityFactory.createEntity(kind, id);

                this.dispatch(Events.SPAWN_ITEM, item, x, y);
            } else if(Types.isChest(kind)) {
                var item = EntityFactory.createEntity(kind, id);

                this.dispatch(Events.SPAWN_CHEST, item, x, y);
            } else {
                var name, orientation, target, weapon, armor;

                if(Types.isPlayer(kind)) {
                    name = data[5];
                    orientation = data[6];
                    armor = data[7];
                    weapon = data[8];
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

                this.dispatch(Events.SPAWN_CHARACTER, character, x, y, orientation, target);
            }
        },

        receiveDespawn: function(data) {
            var id = data[1];

            this.dispatch(Events.DESPAWN, id);
        },

        receiveDestroy: function(data) {
            var id = data[1];

            this.dispatch(Events.DESTROY, id);
        },

        receiveMove: function(data) {
            var id = data[1],
                x = data[2],
                y = data[3];

            this.dispatch(Events.MOVE, id, x, y);
        },

        receiveLootMove: function(data) {
            var id = data[1],
                item = data[2];

            this.dispatch(Events.LOOT_MOVE, id, item);
        },

        receiveAttack: function(data) {
            var attacker = data[1],
                target = data[2];

            this.dispatch(Events.ATTACK, attacker, target);
        },

        receiveTeleport: function(data) {
            var id = data[1],
                x = data[2],
                y = data[3];

            this.dispatch(Events.TELEPORT, id, x, y);
        },

        receiveEquipItem: function(data) {
            var id = data[1],
                itemKind = data[2];

            this.dispatch(Events.EQUIP, id, itemKind);
        },

        receiveDrop: function(data) {
            var mobId = data[1],
                id = data[2],
                kind = data[3];

            var item = EntityFactory.createEntity(kind, id);
            item.wasDropped = true;
            item.playersInvolved = data[4];

            this.dispatch(Events.DROP, item, mobId);
        },

        receiveBlink: function(data) {
            var id = data[1];

            this.dispatch(Events.BLINK, id);
        },

        receiveList: function(data) {
            data.shift(); // drop the message type; the rest is the list of ids

            this.dispatch(Events.LIST, data);
        },

        // --- HUD, chat and notifications ---

        receiveChat: function(data) {
            var id = data[1],
                text = data[2];

            this.dispatch(Events.CHAT, id, text);
        },

        receivePopulation: function(data) {
            var worldPlayers = data[1],
                totalPlayers = data[2];

            this.dispatch(Events.POPULATION, worldPlayers, totalPlayers);
        },

        receiveDamage: function(data) {
            var id = data[1],
                dmg = data[2];

            this.dispatch(Events.DAMAGE, id, dmg);
        },

        receiveKill: function(data) {
            var mobKind = data[1];

            this.dispatch(Events.KILL, mobKind);
        },

        // === 5. SUBSCRIPTION API ==================================================
        // One consumer per event. Grouped to mirror the decoders above, so the
        // entity / player / ui split is the same on both the producing and the
        // consuming side.

        // --- Connection lifecycle ---

        onDispatched: function(callback) {
            this.bind(Events.DISPATCHED, callback);
        },

        onConnected: function(callback) {
            this.bind(Events.CONNECTED, callback);
        },

        onDisconnected: function(callback) {
            this.bind(Events.DISCONNECTED, callback);
        },

        // --- Local player state ---

        onWelcome: function(callback) {
            this.bind(Events.WELCOME, callback);
        },

        onPlayerChangeHealth: function(callback) {
            this.bind(Events.HEALTH, callback);
        },

        onPlayerChangeMaxHitPoints: function(callback) {
            this.bind(Events.MAX_HITPOINTS, callback);
        },

        // --- World entities ---

        onSpawnCharacter: function(callback) {
            this.bind(Events.SPAWN_CHARACTER, callback);
        },

        onSpawnItem: function(callback) {
            this.bind(Events.SPAWN_ITEM, callback);
        },

        onSpawnChest: function(callback) {
            this.bind(Events.SPAWN_CHEST, callback);
        },

        onDespawnEntity: function(callback) {
            this.bind(Events.DESPAWN, callback);
        },

        onEntityDestroy: function(callback) {
            this.bind(Events.DESTROY, callback);
        },

        onEntityMove: function(callback) {
            this.bind(Events.MOVE, callback);
        },

        onPlayerMoveToItem: function(callback) {
            this.bind(Events.LOOT_MOVE, callback);
        },

        onEntityAttack: function(callback) {
            this.bind(Events.ATTACK, callback);
        },

        onPlayerTeleport: function(callback) {
            this.bind(Events.TELEPORT, callback);
        },

        onPlayerEquipItem: function(callback) {
            this.bind(Events.EQUIP, callback);
        },

        onItemBlink: function(callback) {
            this.bind(Events.BLINK, callback);
        },

        onDropItem: function(callback) {
            this.bind(Events.DROP, callback);
        },

        onEntityList: function(callback) {
            this.bind(Events.LIST, callback);
        },

        // --- HUD, chat and notifications ---

        onChatMessage: function(callback) {
            this.bind(Events.CHAT, callback);
        },

        onPopulationChange: function(callback) {
            this.bind(Events.POPULATION, callback);
        },

        onPlayerDamageMob: function(callback) {
            this.bind(Events.DAMAGE, callback);
        },

        onPlayerKillMob: function(callback) {
            this.bind(Events.KILL, callback);
        },

        // === 6. OUTGOING MESSAGES =================================================

        sendMessage: function(json) {
            var data;

            // Guard: only send once the socket is OPEN (readyState 1). Calls made
            // before the connection is ready are silently dropped.
            if(this.connection.readyState === 1) {
                if(this.useBison) {
                    data = BISON.encode(json);
                } else {
                    data = JSON.stringify(json);
                }
                this.connection.send(data);
            }
        },

        sendHello: function(player) {
            this.sendMessage([Types.Messages.HELLO,
                              player.name,
                              Types.getKindFromString(player.getSpriteName()),
                              Types.getKindFromString(player.getWeaponName())]);
        },

        sendMove: function(x, y) {
            this.sendMessage([Types.Messages.MOVE,
                              x,
                              y]);
        },

        sendLootMove: function(item, x, y) {
            this.sendMessage([Types.Messages.LOOTMOVE,
                              x,
                              y,
                              item.id]);
        },

        sendAggro: function(mob) {
            this.sendMessage([Types.Messages.AGGRO,
                              mob.id]);
        },

        sendAttack: function(mob) {
            this.sendMessage([Types.Messages.ATTACK,
                              mob.id]);
        },

        sendHit: function(mob) {
            this.sendMessage([Types.Messages.HIT,
                              mob.id]);
        },

        sendHurt: function(mob) {
            this.sendMessage([Types.Messages.HURT,
                              mob.id]);
        },

        sendChat: function(text) {
            this.sendMessage([Types.Messages.CHAT,
                              text]);
        },

        sendLoot: function(item) {
            this.sendMessage([Types.Messages.LOOT,
                              item.id]);
        },

        sendTeleport: function(x, y) {
            this.sendMessage([Types.Messages.TELEPORT,
                              x,
                              y]);
        },

        sendWho: function(ids) {
            ids.unshift(Types.Messages.WHO);
            this.sendMessage(ids);
        },

        sendZone: function() {
            this.sendMessage([Types.Messages.ZONE]);
        },

        sendOpen: function(chest) {
            this.sendMessage([Types.Messages.OPEN,
                              chest.id]);
        },

        sendCheck: function(id) {
            this.sendMessage([Types.Messages.CHECK,
                              id]);
        }
    });

    return GameClient;
});
