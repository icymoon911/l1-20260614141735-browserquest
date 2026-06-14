
var cls = require("./lib/class"),
    _ = require("underscore"),
    Item = require("./item"),
    Chest = require("./chest"),
    Messages = require("./message"),
    Types = require("../../shared/js/gametypes");

/**
 * ItemManager
 *
 * Owns the full item lifecycle that used to live on WorldServer: creation,
 * static / chest / loot spawning, blinking and despawn timers, and chest
 * opening logic.
 *
 * References the WorldServer ("world") so it can add entities to the
 * registry, push messages through the broadcast manager and trigger
 * zone-group bookkeeping.
 */
module.exports = ItemManager = cls.Class.extend({
    init: function(world) {
        this.world = world;
        this.itemCount = 0;
    },

    // ---- item creation --------------------------------------------------

    createItem: function(kind, x, y) {
        var id = '9' + this.itemCount++,
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

    // ---- spawning -------------------------------------------------------

    /** Add an item entity to the world (registry + zone groups). */
    addItem: function(item) {
        this.world.addEntity(item);
        this.world.entityRegistry.addItem(item);
        return item;
    },

    /** Mark an item as static (permanent world decoration) and wire up its respawn. */
    addStaticItem: function(item) {
        item.isStatic = true;
        item.onRespawn(this.addStaticItem.bind(this, item));
        return this.addItem(item);
    },

    /** Create and register an item dropped from a chest. */
    addItemFromChest: function(kind, x, y) {
        var item = this.createItem(kind, x, y);
        item.isFromChest = true;
        return this.addItem(item);
    },

    // ---- despawn --------------------------------------------------------

    handleItemDespawn: function(item) {
        var self = this;
        if(item) {
            item.handleDespawn({
                beforeBlinkDelay: 10000,
                blinkCallback: function() {
                    self.world.pushToAdjacentGroups(
                        item.group, new Messages.Blink(item));
                },
                blinkingDuration: 4000,
                despawnCallback: function() {
                    self.world.pushToAdjacentGroups(
                        item.group, new Messages.Destroy(item));
                    self.world.removeEntity(item);
                }
            });
        }
    },

    // ---- chests ---------------------------------------------------------

    handleOpenedChest: function(chest, player) {
        this.world.pushToAdjacentGroups(chest.group, chest.despawn());
        this.world.removeEntity(chest);

        var kind = chest.getRandomItem();
        if(kind) {
            var item = this.addItemFromChest(kind, chest.x, chest.y);
            this.handleItemDespawn(item);
        }
    },

    handleEmptyChestArea: function(area) {
        if(area) {
            var chest = this.addItem(
                this.createChest(area.chestX, area.chestY, area.items));
            this.handleItemDespawn(chest);
        }
    }
});
