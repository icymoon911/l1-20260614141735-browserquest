
var cls = require("./lib/class"),
    _ = require("underscore");

/**
 * Broadcast layer.
 *
 * Translates "send this to everyone near X" into concrete per-player pushes. It
 * reads group membership from the GroupManager, resolves player objects through
 * the EntityManager, and hands the actual delivery to the ConnectionManager. If
 * the wrong people are (or aren't) receiving updates, the fan-out logic is here.
 */
var Broadcaster = cls.Class.extend({
    init: function(map, groupManager, connection, entityManager) {
        this.map = map;
        this.groupManager = groupManager;
        this.connection = connection;
        this.entityManager = entityManager;
    },

    pushToGroup: function(groupId, message, ignoredPlayer) {
        var self = this,
            group = this.groupManager.getGroup(groupId);

        if(group) {
            _.each(group.players, function(playerId) {
                if(playerId != ignoredPlayer) {
                    self.connection.pushToPlayer(self.entityManager.get(playerId), message);
                }
            });
        } else {
            log.error("groupId: "+groupId+" is not a valid group");
        }
    },

    pushToAdjacentGroups: function(groupId, message, ignoredPlayer) {
        var self = this;
        this.map.forEachAdjacentGroup(groupId, function(id) {
            self.pushToGroup(id, message, ignoredPlayer);
        });
    },

    pushToPreviousGroups: function(player, message) {
        var self = this;

        // Push this message to all groups which are not going to be updated anymore,
        // since the player left them.
        _.each(player.recentlyLeftGroups, function(id) {
            self.pushToGroup(id, message);
        });
        player.recentlyLeftGroups = [];
    }
});

module.exports = Broadcaster;
