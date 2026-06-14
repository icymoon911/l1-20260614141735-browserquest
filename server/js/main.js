
var fs = require('fs'),
    Metrics = require('./metrics');


/**
 * Create and start all game worlds, returning a handle that the connection
 * layer can use to route incoming players.
 *
 * Keeping world creation separate from the websocket connection handler
 * makes it possible to reason about startup and runtime independently.
 */
function createWorlds(config, websocketServer, metrics) {
    var WorldServer = require("./worldserver"),
        _ = require("underscore"),
        worlds = [];

    _.each(_.range(config.nb_worlds), function(i) {
        var world = new WorldServer(
            'world' + (i + 1),
            config.nb_players_per_world,
            websocketServer
        );
        world.run(config.map_filepath);
        worlds.push(world);
    });

    return worlds;
}

/**
 * Return a function that, given a list of worlds, picks the one a new
 * player should join.  The strategy depends on whether we have a metrics
 * backend (memcached) available.
 */
function createWorldSelector(config, metrics) {
    var _ = require("underscore");

    if(metrics) {
        // Choose the least populated world among the currently open ones.
        return function(worlds, callback) {
            metrics.getOpenWorldCount(function(open_world_count) {
                var world = _.min(
                    _.first(worlds, open_world_count),
                    function(w) { return w.playerCount; }
                );
                callback(world);
            });
        };
    }

    // No metrics – fill worlds sequentially until they are full.
    return function(worlds, callback) {
        var world = _.detect(worlds, function(w) {
            return w.playerCount < config.nb_players_per_world;
        });
        callback(world);
    };
}

/**
 * Build the population-change handler that keeps metrics and all worlds in
 * sync.  Returns null when metrics are disabled.
 */
function createPopulationHandler(worlds, metrics) {
    if(!metrics) { return null; }

    var _ = require("underscore");

    return function() {
        metrics.updatePlayerCounters(worlds, function(totalPlayers) {
            _.each(worlds, function(world) {
                world.updatePopulation(totalPlayers);
            });
        });
        metrics.updateWorldDistribution(getWorldDistribution(worlds));
    };
}

/**
 * Wire up the websocket connection handler so that every new client is
 * routed to an appropriate world.
 */
function setupConnectionHandler(websocketServer, worlds, selectWorld, Player) {
    websocketServer.onConnect(function(connection) {
        selectWorld(worlds, function(world) {
            if(world) {
                var player = new Player(connection, world);
                world.connect_callback(player);
            }
        });
    });
}

/**
 * Start a periodic check that pushes updated total-player counts to every
 * world (used for the population display in the client).
 */
function startPopulationPoll(metrics, worlds) {
    if(!metrics) { return null; }

    var lastTotalPlayers = 0;
    return setInterval(function() {
        if(metrics.isReady) {
            metrics.getTotalPlayers(function(totalPlayers) {
                if(totalPlayers !== lastTotalPlayers) {
                    lastTotalPlayers = totalPlayers;
                    var _ = require("underscore");
                    _.each(worlds, function(world) {
                        world.updatePopulation(totalPlayers);
                    });
                }
            });
        }
    }, 1000);
}

/**
 * Aggregate the player count of each world into a plain array, used by the
 * /status endpoint and the metrics backend.
 */
function getWorldDistribution(worlds) {
    var distribution = [],
        _ = require("underscore");

    _.each(worlds, function(world) {
        distribution.push(world.playerCount);
    });
    return distribution;
}

function getConfigFile(path, callback) {
    fs.readFile(path, 'utf8', function(err, json_string) {
        if(err) {
            console.error("Could not open config file:", err.path);
            callback(null);
        } else {
            callback(JSON.parse(json_string));
        }
    });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(config) {
    var ws              = require("./ws"),
        Log             = require('log'),
        WorldServer     = require("./worldserver"),
        Player          = require("./player"),
        _               = require("underscore"),
        websocketServer = new ws.MultiVersionWebsocketServer(config.port),
        metrics         = config.metrics_enabled ? new Metrics(config) : null;

    // ---- logging ---------------------------------------------------------
    switch(config.debug_level) {
        case "error":
            log = new Log(Log.ERROR); break;
        case "debug":
            log = new Log(Log.DEBUG); break;
        case "info":
            log = new Log(Log.INFO); break;
    }

    log.info("Starting BrowserQuest game server...");

    // ---- world creation --------------------------------------------------
    var worlds       = createWorlds(config, websocketServer, metrics),
        selectWorld  = createWorldSelector(config, metrics),
        onPopChange  = createPopulationHandler(worlds, metrics);

    // ---- metrics wiring --------------------------------------------------
    if(metrics && onPopChange) {
        _.each(worlds, function(world) {
            world.onPlayerAdded(onPopChange);
            world.onPlayerRemoved(onPopChange);
        });
    }

    // ---- connection routing ----------------------------------------------
    setupConnectionHandler(websocketServer, worlds, selectWorld, Player);

    websocketServer.onError(function() {
        log.error(Array.prototype.join.call(arguments, ", "));
    });

    websocketServer.onRequestStatus(function() {
        return JSON.stringify(getWorldDistribution(worlds));
    });

    // ---- background population poll --------------------------------------
    startPopulationPoll(metrics, worlds);

    // ---- initial metrics -------------------------------------------------
    if(config.metrics_enabled && metrics) {
        metrics.ready(function() {
            if(onPopChange) {
                onPopChange(); // initialise all counters to 0 at startup
            }
        });
    }

    // ---- unhandled errors ------------------------------------------------
    process.on('uncaughtException', function(e) {
        log.error('uncaughtException: ' + e);
    });
}

// ---------------------------------------------------------------------------
// Config loading & bootstrap
// ---------------------------------------------------------------------------

var defaultConfigPath = './server/config.json',
    customConfigPath  = './server/config_local.json';

process.argv.forEach(function(val, index, array) {
    if(index === 2) {
        customConfigPath = val;
    }
});

getConfigFile(defaultConfigPath, function(defaultConfig) {
    getConfigFile(customConfigPath, function(localConfig) {
        if(localConfig) {
            main(localConfig);
        } else if(defaultConfig) {
            main(defaultConfig);
        } else {
            console.error("Server cannot start without any configuration file.");
            process.exit(1);
        }
    });
});
