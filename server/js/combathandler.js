
var cls = require("./lib/class"),
    _ = require("underscore"),
    Messages = require("./message"),
    Properties = require("./properties"),
    Utils = require("./utils"),
    Types = require("../../shared/js/gametypes");

/**
 * CombatHandler
 *
 * Owns all combat-related logic that used to be spread across WorldServer:
 * damage resolution, hate-list management, mob target selection, entity
 * death / despawn, loot drops and player vanish handling.
 *
 * The handler receives a reference to the WorldServer (its "world") so it
 * can reach the entity registry, broadcast manager and zone manager through
 * it.  This keeps CombatHandler focused on *what* happens during combat
 * while delegating *how* messages reach clients to the broadcast layer.
 */
module.exports = CombatHandler = cls.Class.extend({
    init: function(world) {
        this.world = world;
    },

    // ---- hate / aggro ---------------------------------------------------

    handleMobHate: function(mobId, playerId, hatePoints) {
        var mob    = this.world.getEntityById(mobId),
            player = this.world.getEntityById(playerId);

        if(player && mob) {
            mob.increaseHateFor(playerId, hatePoints);
            player.addHater(mob);

            if(mob.hitPoints > 0) {
                this.chooseMobTarget(mob);
            }
        }
    },

    chooseMobTarget: function(mob, hateRank) {
        var player = this.world.getEntityById(mob.getHatedPlayerId(hateRank));

        if(player && !(mob.id in player.attackers)) {
            this.clearMobAggroLink(mob);

            player.addAttacker(mob);
            mob.setTarget(player);

            this.world.broadcastAttacker(mob);
            log.debug(mob.id + " is now attacking " + player.id);
        }
    },

    /**
     * Unregister the mob as an attacker of its current target.
     */
    clearMobAggroLink: function(mob) {
        if(mob.target) {
            var player = this.world.getEntityById(mob.target);
            if(player) {
                player.removeAttacker(mob);
            }
        }
    },

    clearMobHateLinks: function(mob) {
        var self = this;
        if(mob) {
            _.each(mob.hatelist, function(obj) {
                var player = self.world.getEntityById(obj.id);
                if(player) {
                    player.removeHater(mob);
                }
            });
        }
    },

    // ---- attack broadcast -----------------------------------------------

    broadcastAttacker: function(character) {
        if(character) {
            this.world.pushToAdjacentGroups(
                character.group, character.attack(), character.id);
        }
        if(this.world.attack_callback) {
            this.world.attack_callback(character);
        }
    },

    // ---- damage / death -------------------------------------------------

    handleHurtEntity: function(entity, attacker, damage) {
        var self = this;

        if(entity.type === 'player') {
            this.world.pushToPlayer(entity, entity.health());
        }

        if(entity.type === 'mob') {
            this.world.pushToPlayer(attacker, new Messages.Damage(entity, damage));
        }

        if(entity.hitPoints <= 0) {
            if(entity.type === "mob") {
                var mob  = entity,
                    item = this.getDroppedItem(mob);

                this.world.pushToPlayer(attacker, new Messages.Kill(mob));
                // Despawn must be enqueued before the item drop.
                this.world.pushToAdjacentGroups(mob.group, mob.despawn());
                if(item) {
                    this.world.pushToAdjacentGroups(mob.group, mob.drop(item));
                    this.world.handleItemDespawn(item);
                }
            }

            if(entity.type === "player") {
                this.handlePlayerVanish(entity);
                this.world.pushToAdjacentGroups(entity.group, entity.despawn());
            }

            this.world.removeEntity(entity);
        }
    },

    // ---- player vanish --------------------------------------------------

    /**
     * When a player dies or teleports, re-target each of its attackers to
     * their second-most-hated player, then clear the attack links.
     */
    handlePlayerVanish: function(player) {
        var self = this,
            previousAttackers = [];

        player.forEachAttacker(function(mob) {
            previousAttackers.push(mob);
            self.chooseMobTarget(mob, 2);
        });

        _.each(previousAttackers, function(mob) {
            player.removeAttacker(mob);
            mob.clearTarget();
            mob.forgetPlayer(player.id, 1000);
        });

        this.world.handleEntityGroupMembership(player);
    },

    // ---- loot / drops ---------------------------------------------------

    getDroppedItem: function(mob) {
        var kind  = Types.getKindAsString(mob.kind),
            drops = Properties[kind].drops,
            v     = Utils.random(100),
            p     = 0,
            item  = null;

        for(var itemName in drops) {
            var percentage = drops[itemName];
            p += percentage;
            if(v <= p) {
                item = this.world.addItem(
                    this.world.createItem(
                        Types.getKindFromString(itemName), mob.x, mob.y));
                break;
            }
        }
        return item;
    }
});
