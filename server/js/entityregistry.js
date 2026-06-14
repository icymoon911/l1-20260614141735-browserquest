
var cls = require("./lib/class");

/**
 * EntityRegistry
 *
 * Unified entity collection management.  Replaces the separate flat
 * dictionaries (entities, players, mobs, items, npcs, …) that used to live
 * directly on WorldServer with a single registry that provides consistent
 * add / remove / get / forEach helpers for every entity type.
 *
 * Design goals
 *   - One canonical store per entity type – no more duplicated bookkeeping
 *     scattered across WorldServer methods.
 *   - A uniform access pattern: adding any new entity kind only requires
 *     calling add(type, entity) rather than copying a new set of helper
 *     methods.
 *   - Behaviour-compatible with the original collections so that callers
 *     (player.js, area.js, …) see no difference.
 */
module.exports = EntityRegistry = cls.Class.extend({
    init: function() {
        // Primary store: every entity indexed by id.
        this.entities = {};

        // Per-type secondary stores.  These are plain objects so that
        // existing `id in store` checks and `for…in` iterations behave
        // identically to the original code.
        this.players = {};
        this.mobs    = {};
        this.items   = {};
        this.npcs    = {};
    },

    // ---- primary store --------------------------------------------------

    /**
     * Register an entity in the primary store.
     * Does NOT add to a type-specific collection – call addPlayer / addMob /
     * … separately (or use the generic addWithType helper).
     */
    add: function(entity) {
        this.entities[entity.id] = entity;
    },

    /** Remove an entity from the primary store (no-op if absent). */
    remove: function(entity) {
        if(entity && entity.id in this.entities) {
            delete this.entities[entity.id];
        }
    },

    /**
     * Look up an entity by id.
     * Logs an error and returns undefined when not found – same behaviour
     * as the original WorldServer.getEntityById.
     */
    getEntity: function(id) {
        if(id in this.entities) {
            return this.entities[id];
        } else {
            log.error("Unknown entity : " + id);
        }
    },

    /** Look up an entity by id without logging on miss. */
    getEntitySilent: function(id) {
        return this.entities[id];
    },

    /** True when the primary store contains this id. */
    hasEntity: function(id) {
        return id in this.entities;
    },

    // ---- type-specific stores -------------------------------------------

    addPlayer: function(player) {
        this.players[player.id] = player;
    },

    removePlayer: function(player) {
        delete this.players[player.id];
    },

    addMob: function(mob) {
        this.mobs[mob.id] = mob;
    },

    removeMob: function(mob) {
        delete this.mobs[mob.id];
    },

    addItem: function(item) {
        this.items[item.id] = item;
    },

    removeItem: function(item) {
        delete this.items[item.id];
    },

    addNpc: function(npc) {
        this.npcs[npc.id] = npc;
    },

    /**
     * Remove an entity from every type-specific collection it might belong
     * to.  Mirrors the original removeEntity logic which cleaned entities,
     * mobs and items in one pass.
     */
    removeFromTypeCollections: function(entity) {
        if(entity.id in this.mobs) {
            delete this.mobs[entity.id];
        }
        if(entity.id in this.items) {
            delete this.items[entity.id];
        }
    },

    // ---- iteration ------------------------------------------------------

    forEachEntity: function(callback) {
        for(var id in this.entities) {
            callback(this.entities[id]);
        }
    },

    forEachPlayer: function(callback) {
        for(var id in this.players) {
            callback(this.players[id]);
        }
    },

    forEachMob: function(callback) {
        for(var id in this.mobs) {
            callback(this.mobs[id]);
        }
    },

    forEachCharacter: function(callback) {
        this.forEachPlayer(callback);
        this.forEachMob(callback);
    },

    // ---- collection accessors -------------------------------------------

    getPlayers: function() { return this.players; },
    getMobs:    function() { return this.mobs; },
    getItems:   function() { return this.items; },
    getNpcs:    function() { return this.npcs; },
    getEntities: function() { return this.entities; }
});
