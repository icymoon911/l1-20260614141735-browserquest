
var cls = require("./lib/class");

// Load the base classes first so the Entity/Character globals the concrete
// entity modules extend are in place before we pull those modules in.
require("./entity");
require("./character");
var Player = require("./player"),
    Mob = require("./mob"),
    Item = require("./item"),
    Npc = require("./npc");

/**
 * World entity state.
 *
 * Holds the single source of truth for every entity (`entities`) plus a set of
 * typed secondary indexes (players, mobs, items, npcs). Each index is described
 * by a predicate, so registering a new kind of bucket is one register() call
 * instead of copying add/remove bookkeeping into a handful of methods.
 */
var EntityManager = cls.Class.extend({
    init: function() {
        this.entities = {};
        this.itemCount = 0;

        this.collections = [];
        this.collectionsByName = {};

        this.register("players", function(entity) { return entity instanceof Player; });
        this.register("mobs",    function(entity) { return entity instanceof Mob; });
        this.register("items",   function(entity) { return entity instanceof Item; });
        this.register("npcs",    function(entity) { return entity instanceof Npc; });
    },

    /**
     * Declare a secondary index. Any entity matching `predicate` is mirrored
     * into this collection on add() and pulled back out on remove().
     */
    register: function(name, predicate) {
        var collection = { name: name, predicate: predicate, entities: {} };
        this.collections.push(collection);
        this.collectionsByName[name] = collection.entities;
        return collection.entities;
    },

    collection: function(name) {
        return this.collectionsByName[name];
    },

    add: function(entity) {
        this.entities[entity.id] = entity;
        for(var i = 0; i < this.collections.length; i += 1) {
            var collection = this.collections[i];
            if(collection.predicate(entity)) {
                collection.entities[entity.id] = entity;
            }
        }
        return entity;
    },

    remove: function(entity) {
        delete this.entities[entity.id];
        for(var i = 0; i < this.collections.length; i += 1) {
            delete this.collections[i].entities[entity.id];
        }
    },

    get: function(id) {
        return this.entities[id];
    },

    has: function(id) {
        return id in this.entities;
    },

    forEach: function(callback) {
        for(var id in this.entities) {
            callback(this.entities[id]);
        }
    },

    forEachIn: function(name, callback) {
        var entities = this.collectionsByName[name];
        for(var id in entities) {
            callback(entities[id]);
        }
    },

    count: function(name) {
        var entities = name ? this.collectionsByName[name] : this.entities,
            n = 0;
        for(var id in entities) {
            if(entities.hasOwnProperty(id)) {
                n += 1;
            }
        }
        return n;
    },

    nextItemId: function() {
        return '9' + this.itemCount++;
    }
});

module.exports = EntityManager;
