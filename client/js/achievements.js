
define([], function() {

    /**
     * Achievement data definitions.
     * Separated from game.js so that achievement metadata is independent
     * of game engine logic.
     *
     * buildAchievements(storage) returns a map of achievement objects,
     * each with an isCompleted() method bound to the given storage instance.
     */

    function buildAchievements(storage) {
        var achievements = {
            A_TRUE_WARRIOR: {
                id: 1,
                name: "A True Warrior",
                desc: "Find a new weapon"
            },
            INTO_THE_WILD: {
                id: 2,
                name: "Into the Wild",
                desc: "Venture outside the village"
            },
            ANGRY_RATS: {
                id: 3,
                name: "Angry Rats",
                desc: "Kill 10 rats",
                isCompleted: function() {
                    return storage.getRatCount() >= 10;
                }
            },
            SMALL_TALK: {
                id: 4,
                name: "Small Talk",
                desc: "Talk to a non-player character"
            },
            FAT_LOOT: {
                id: 5,
                name: "Fat Loot",
                desc: "Get a new armor set"
            },
            UNDERGROUND: {
                id: 6,
                name: "Underground",
                desc: "Explore at least one cave"
            },
            AT_WORLDS_END: {
                id: 7,
                name: "At World's End",
                desc: "Reach the south shore"
            },
            COWARD: {
                id: 8,
                name: "Coward",
                desc: "Successfully escape an enemy"
            },
            TOMB_RAIDER: {
                id: 9,
                name: "Tomb Raider",
                desc: "Find the graveyard"
            },
            SKULL_COLLECTOR: {
                id: 10,
                name: "Skull Collector",
                desc: "Kill 10 skeletons",
                isCompleted: function() {
                    return storage.getSkeletonCount() >= 10;
                }
            },
            NINJA_LOOT: {
                id: 11,
                name: "Ninja Loot",
                desc: "Get hold of an item you didn't fight for"
            },
            NO_MANS_LAND: {
                id: 12,
                name: "No Man's Land",
                desc: "Travel through the desert"
            },
            HUNTER: {
                id: 13,
                name: "Hunter",
                desc: "Kill 50 enemies",
                isCompleted: function() {
                    return storage.getTotalKills() >= 50;
                }
            },
            STILL_ALIVE: {
                id: 14,
                name: "Still Alive",
                desc: "Revive your character five times",
                isCompleted: function() {
                    return storage.getTotalRevives() >= 5;
                }
            },
            MEATSHIELD: {
                id: 15,
                name: "Meatshield",
                desc: "Take 5,000 points of damage",
                isCompleted: function() {
                    return storage.getTotalDamageTaken() >= 5000;
                }
            },
            HOT_SPOT: {
                id: 16,
                name: "Hot Spot",
                desc: "Enter the volcanic mountains"
            },
            HERO: {
                id: 17,
                name: "Hero",
                desc: "Defeat the final boss"
            },
            FOXY: {
                id: 18,
                name: "Foxy",
                desc: "Find the Firefox costume",
                hidden: true
            },
            FOR_SCIENCE: {
                id: 19,
                name: "For Science",
                desc: "Enter into a portal",
                hidden: true
            },
            RICKROLLD: {
                id: 20,
                name: "Rickroll'd",
                desc: "Take some singing lessons",
                hidden: true
            }
        };

        // Normalize: ensure every achievement has isCompleted and hidden fields
        _.each(achievements, function(obj) {
            if(!obj.isCompleted) {
                obj.isCompleted = function() { return true; };
            }
            if(!obj.hidden) {
                obj.hidden = false;
            }
        });

        return achievements;
    }

    return {
        build: buildAchievements
    };
});
