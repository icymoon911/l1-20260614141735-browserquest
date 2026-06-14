
var cls = require("./lib/class"),
    _ = require("underscore");

// Load the base classes first so the entity globals are in place before the
// concrete entity modules used for instanceof checks are pulled in.
require("./entity");
require("./character");
var Player = require("./player"),
    Item = require("./item"),
    Chest = require("./chest");

/**
 * Zone / spatial state ("world layer").
 *
 * Owns the zone groups and every entity's membership in them. It only tracks
 * who is where — it never sends anything. Spawn/despawn messaging that results
 * from membership changes is the broadcaster's job; this class just reports what
 * changed (incoming lists, recentlyLeftGroups) so the orchestrator can react.
 */
var GroupManager = cls.Class.extend({
    init: function(map) {
        this.map = map;
        this.groups = {};
        this.zoneGroupsReady = false;
    },

    /** Build one bucket per zone group. Mirrors the old WorldServer.initZoneGroups. */
    build: function() {
        var self = this;

        this.map.forEachGroup(function(id) {
            self.groups[id] = { entities: {},
                                players: [],
                                incoming: [] };
        });
        this.zoneGroupsReady = true;
    },

    getGroup: function(id) {
        return this.groups[id];
    },

    hasGroup: function(id) {
        return id in this.groups;
    },

    forEachGroup: function(callback) {
        this.map.forEachGroup(callback);
    },

    removeFromGroups: function(entity) {
        var self = this,
            oldGroups = [];

        if(entity && entity.group) {

            var group = this.groups[entity.group];
            if(entity instanceof Player) {
                group.players = _.reject(group.players, function(id) { return id === entity.id; });
            }

            this.map.forEachAdjacentGroup(entity.group, function(id) {
                if(entity.id in self.groups[id].entities) {
                    delete self.groups[id].entities[entity.id];
                    oldGroups.push(id);
                }
            });
            entity.group = null;
        }
        return oldGroups;
    },

    /**
     * Registers an entity as "incoming" into several groups, meaning that it just entered them.
     * All players inside these groups will receive a Spawn message when the incoming
     * lists are drained (see WorldServer.processGroups).
     */
    addAsIncomingToGroup: function(entity, groupId) {
        var self = this,
            isChest = entity && entity instanceof Chest,
            isItem = entity && entity instanceof Item,
            isDroppedItem =  entity && isItem && !entity.isStatic && !entity.isFromChest;

        if(entity && groupId) {
            this.map.forEachAdjacentGroup(groupId, function(id) {
                var group = self.groups[id];

                if(group) {
                    if(!_.include(group.entities, entity.id)
                    //  Items dropped off of mobs are handled differently via DROP messages. See handleHurtEntity.
                    && (!isItem || isChest || (isItem && !isDroppedItem))) {
                        group.incoming.push(entity);
                    }
                }
            });
        }
    },

    addToGroup: function(entity, groupId) {
        var self = this,
            newGroups = [];

        if(entity && groupId && (groupId in this.groups)) {
            this.map.forEachAdjacentGroup(groupId, function(id) {
                self.groups[id].entities[entity.id] = entity;
                newGroups.push(id);
            });
            entity.group = groupId;

            if(entity instanceof Player) {
                this.groups[groupId].players.push(entity.id);
            }
        }
        return newGroups;
    },

    handleEntityGroupMembership: function(entity) {
        var hasChangedGroups = false;
        if(entity) {
            var groupId = this.map.getGroupIdFromPosition(entity.x, entity.y);
            if(!entity.group || (entity.group && entity.group !== groupId)) {
                hasChangedGroups = true;
                this.addAsIncomingToGroup(entity, groupId);
                var oldGroups = this.removeFromGroups(entity);
                var newGroups = this.addToGroup(entity, groupId);

                if(_.size(oldGroups) > 0) {
                    entity.recentlyLeftGroups = _.difference(oldGroups, newGroups);
                    log.debug("group diff: " + entity.recentlyLeftGroups);
                }
            }
        }
        return hasChangedGroups;
    },

    logGroupPlayers: function(groupId) {
        log.debug("Players inside group "+groupId+":");
        _.each(this.groups[groupId].players, function(id) {
            log.debug("- player "+id);
        });
    }
});

module.exports = GroupManager;
