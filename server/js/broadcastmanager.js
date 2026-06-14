
var cls = require("./lib/class"),
    _ = require("underscore");

/**
 * BroadcastManager
 *
 * Owns every outgoing message queue and all push / flush operations that
 * used to live directly on WorldServer.  The rest of the server hands it a
 * reference to the websocket server and the entity registry so it can
 * resolve connections and players without knowing anything about combat or
 * zone logic.
 *
 * Responsibilities
 *   - Per-player outgoing message queues (outgoingQueues).
 *   - Point-to-point pushes (pushToPlayer).
 *   - Group-scoped pushes (pushToGroup, pushToAdjacentGroups,
 *     pushToPreviousGroups).
 *   - Server-wide broadcasts (pushBroadcast).
 *   - Periodic queue flushing (processQueues).
 */
module.exports = BroadcastManager = cls.Class.extend({
    init: function(websocketServer, entityRegistry) {
        this.server        = websocketServer;
        this.entityRegistry = entityRegistry;
        this.outgoingQueues = {};
    },

    // ---- queue lifecycle ------------------------------------------------

    addPlayerQueue: function(playerId) {
        this.outgoingQueues[playerId] = [];
    },

    removePlayerQueue: function(playerId) {
        delete this.outgoingQueues[playerId];
    },

    // ---- point-to-point -------------------------------------------------

    pushToPlayer: function(player, message) {
        if(player && player.id in this.outgoingQueues) {
            this.outgoingQueues[player.id].push(message.serialize());
        } else {
            log.error("pushToPlayer: player was undefined");
        }
    },

    // ---- group-scoped ---------------------------------------------------

    pushToGroup: function(groupId, message, ignoredPlayer) {
        var self = this;
        var group = this._resolveGroup(groupId);

        if(group) {
            _.each(group.players, function(playerId) {
                if(playerId != ignoredPlayer) {
                    var player = self.entityRegistry.getEntitySilent(playerId);
                    if(player) {
                        self.pushToPlayer(player, message);
                    }
                }
            });
        } else if(this.zoneManager) {
            // Only log when the zone manager is initialised – before run()
            // the groups dict is intentionally empty.
            log.error("groupId: " + groupId + " is not a valid group");
        }
    },

    pushToAdjacentGroups: function(groupId, message, ignoredPlayer) {
        var self = this;
        if(!this.map) { return; }
        this.map.forEachAdjacentGroup(groupId, function(id) {
            self.pushToGroup(id, message, ignoredPlayer);
        });
    },

    pushToPreviousGroups: function(player, message) {
        var self = this;
        _.each(player.recentlyLeftGroups, function(id) {
            self.pushToGroup(id, message);
        });
        player.recentlyLeftGroups = [];
    },

    // ---- server-wide ----------------------------------------------------

    pushBroadcast: function(message, ignoredPlayer) {
        for(var id in this.outgoingQueues) {
            if(id != ignoredPlayer) {
                this.outgoingQueues[id].push(message.serialize());
            }
        }
    },

    // ---- queue flushing -------------------------------------------------

    processQueues: function() {
        var connection;
        for(var id in this.outgoingQueues) {
            if(this.outgoingQueues[id].length > 0) {
                connection = this.server.getConnection(id);
                connection.send(this.outgoingQueues[id]);
                this.outgoingQueues[id] = [];
            }
        }
    },

    // ---- wiring helpers (called by WorldServer once) --------------------

    /**
     * Attach the Map instance so pushToAdjacentGroups can enumerate
     * neighbouring groups.
     */
    setMap: function(map) {
        this.map = map;
    },

    /**
     * Attach the zone manager so pushToGroup can look up group state by id.
     */
    setZoneManager: function(zoneManager) {
        this.zoneManager = zoneManager;
    },

    // ---- internal -------------------------------------------------------

    _resolveGroup: function(groupId) {
        if(this.zoneManager) {
            return this.zoneManager.getGroup(groupId);
        }
        return null;
    }
});
