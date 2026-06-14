
var cls = require("./lib/class"),
    _ = require("underscore"),
    Messages = require("./message"),
    Player = require("./player"),
    Chest = require("./chest"),
    Item = require("./item");

/**
 * ZoneManager
 *
 * Manages zone group state and entity-to-group membership.  Extracted from
 * WorldServer so that the spatial bookkeeping (which groups exist, which
 * entities are in them, how entities move between groups) is isolated from
 * combat, broadcasting and connection handling.
 *
 * Responsibilities
 *   - Zone group dictionary lifecycle (initZoneGroups).
 *   - Adding / removing entities from groups (addToGroup, removeFromGroups,
 *     addAsIncomingToGroup).
 *   - Detecting group-boundary crossings (handleEntityGroupMembership).
 *   - Flushing pending spawn announcements each tick (processGroups).
 */
module.exports = ZoneManager = cls.Class.extend({
    init: function(map) {
        this.map = map;
        this.groups = {};
        this.zoneGroupsReady = false;
    },

    // ---- initialisation -------------------------------------------------

    initZoneGroups: function() {
        var self = this;
        this.map.forEachGroup(function(id) {
            self.groups[id] = {
                entities: {},
                players:  [],
                incoming: []
            };
        });
        this.zoneGroupsReady = true;
    },

    // ---- accessors ------------------------------------------------------

    getGroup: function(groupId) {
        return this.groups[groupId] || null;
    },

    getGroups: function() {
        return this.groups;
    },

    isReady: function() {
        return this.zoneGroupsReady;
    },

    // ---- group membership -----------------------------------------------

    removeFromGroups: function(entity) {
        var self = this,
            oldGroups = [];

        if(entity && entity.group) {
            var group = this.groups[entity.group];
            if(entity instanceof Player) {
                group.players = _.reject(group.players, function(id) {
                    return id === entity.id;
                });
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
     * Register an entity as "incoming" in every group adjacent to groupId.
     * Players inside those groups will receive a Spawn message when
     * processGroups runs.
     */
    addAsIncomingToGroup: function(entity, groupId) {
        var self = this,
            isChest = entity && entity instanceof Chest,
            isItem  = entity && entity instanceof Item,
            isDroppedItem = entity && isItem && !entity.isStatic && !entity.isFromChest;

        if(entity && groupId) {
            this.map.forEachAdjacentGroup(groupId, function(id) {
                var group = self.groups[id];
                if(group) {
                    if(!_.include(group.entities, entity.id)
                    // Items dropped off of mobs are handled differently
                    // via DROP messages.  See CombatHandler.handleHurtEntity.
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

    /**
     * Detect whether an entity has crossed a group boundary and, if so,
     * update all affected groups.  Returns true when the entity moved to a
     * new group.
     */
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

    // ---- tick processing ------------------------------------------------

    /**
     * Flush pending spawn announcements for every group.  Called once per
     * server tick.
     */
    processGroups: function(onSpawn) {
        var self = this;
        if(this.zoneGroupsReady) {
            this.map.forEachGroup(function(id) {
                if(self.groups[id].incoming.length > 0) {
                    _.each(self.groups[id].incoming, function(entity) {
                        if(onSpawn) {
                            onSpawn(id, entity);
                        }
                    });
                    self.groups[id].incoming = [];
                }
            });
        }
    },

    // ---- debug ----------------------------------------------------------

    logGroupPlayers: function(groupId) {
        log.debug("Players inside group " + groupId + ":");
        var group = this.groups[groupId];
        if(group) {
            _.each(group.players, function(id) {
                log.debug("- player " + id);
            });
        }
    }
});
