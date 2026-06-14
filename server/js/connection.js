
var cls = require("./lib/class");

/**
 * Connection layer.
 *
 * Owns the per-player outgoing message queues and the websocket server used to
 * flush them. Nothing in here knows about zones, entities or game rules — it is
 * purely "given a player and a message, get the bytes onto the wire". When a
 * delivery problem shows up, this is the only place that touches the transport.
 */
var ConnectionManager = cls.Class.extend({
    init: function(server) {
        this.server = server;
        this.outgoingQueues = {};
    },

    addQueue: function(id) {
        this.outgoingQueues[id] = [];
    },

    removeQueue: function(id) {
        delete this.outgoingQueues[id];
    },

    hasQueue: function(id) {
        return id in this.outgoingQueues;
    },

    pushToPlayer: function(player, message) {
        if(player && this.hasQueue(player.id)) {
            this.outgoingQueues[player.id].push(message.serialize());
        } else {
            log.error("pushToPlayer: player was undefined");
        }
    },

    broadcast: function(message, ignoredId) {
        for(var id in this.outgoingQueues) {
            if(id != ignoredId) {
                this.outgoingQueues[id].push(message.serialize());
            }
        }
    },

    flush: function() {
        var connection;

        for(var id in this.outgoingQueues) {
            if(this.outgoingQueues[id].length > 0) {
                connection = this.server.getConnection(id);
                connection.send(this.outgoingQueues[id]);
                this.outgoingQueues[id] = [];
            }
        }
    }
});

module.exports = ConnectionManager;
