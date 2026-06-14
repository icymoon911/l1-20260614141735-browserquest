
/**
 * App — page lifecycle and startup coordinator.
 *
 * Responsibility boundary:
 *   - App       → page state (intro / createcharacter / loadcharacter / about /
 *                 credits / death / error), parchment animation, device detection,
 *                 play-button state, startup flow.
 *   - Game      → game engine (world, entities, combat, rendering, network).
 *   - UIManager → in-game HUD (health bar, chat, achievements, notifications,
 *                 equipment icons, population).
 *
 * App owns the "which screen is showing" question and coordinates the
 * transition from the intro page into the running game.  Once the game
 * is running, in-game UI is handled by UIManager.
 */
define(['jquery', 'storage', 'config'], function($, Storage, config) {

    var App = Class.extend({
        init: function() {
            this.previousState = null;
            this.isParchmentReady = true;
            this.ready = false;
            this.storage = new Storage();
            this.config = config;

            // Device detection (independent of renderer; see detectDevice())
            this.isMobile = false;
            this.isTablet = false;
            this.isDesktop = true;
            this.supportsWorkers = !!window.Worker;

            // Play-button state watcher
            this.watchNameInputInterval = setInterval(this.toggleButton.bind(this), 100);
            this.$playButton = $('.play');
            this.$playDiv = $('.play div');

            // UIManager reference — set by main.js via setUIManager()
            this.ui = null;
        },

        // -------------------------------------------------------
        // Wiring helpers (called from main.js during bootstrap)
        // -------------------------------------------------------

        /**
         * Attach the Game instance once it has been created and set up.
         * Device flags are derived from the renderer at this point.
         */
        setGame: function(game) {
            this.game = game;
            this.detectDevice(game.renderer);
            this.ready = true;
        },

        /**
         * Attach the UIManager so that App can delegate in-game panel
         * operations (e.g. hideWindows) without owning the details.
         */
        setUIManager: function(ui) {
            this.ui = ui;
        },

        // -------------------------------------------------------
        // Device detection (centralized)
        // -------------------------------------------------------

        /**
         * Derive device-type flags from the renderer's scale information.
         * Called once when the game is attached; used throughout the
         * startup flow and UI decisions.
         */
        detectDevice: function(renderer) {
            this.isMobile = renderer.mobile;
            this.isTablet = renderer.tablet;
            this.isDesktop = !(this.isMobile || this.isTablet);
        },

        // -------------------------------------------------------
        // Utility
        // -------------------------------------------------------

        center: function() {
            window.scrollTo(0, 1);
        },

        // -------------------------------------------------------
        // Startup readiness
        // -------------------------------------------------------

        /**
         * Whether the game is ready to begin playing.
         * On desktop the map must be loaded first (pre-loaded via worker).
         * On mobile/tablet the map is loaded after the player taps PLAY.
         */
        canStartGame: function() {
            if(this.isDesktop) {
                return (this.game && this.game.map && this.game.map.isLoaded);
            } else {
                return !!this.game;
            }
        },

        // -------------------------------------------------------
        // Startup flow
        // -------------------------------------------------------

        /**
         * Entry point when the player clicks/taps the PLAY button.
         * If the game isn't ready yet, show a spinner and poll until it is.
         */
        tryStartingGame: function(username, starting_callback) {
            var self = this,
                $play = this.$playButton;

            if(username !== '') {
                if(!this.ready || !this.canStartGame()) {
                    if(!this.isMobile) {
                        $play.addClass('loading');
                    }
                    this.$playDiv.unbind('click');
                    var watchCanStart = setInterval(function() {
                        log.debug("waiting...");
                        if(self.canStartGame()) {
                            setTimeout(function() {
                                if(!self.isMobile) {
                                    $play.removeClass('loading');
                                }
                            }, 1500);
                            clearInterval(watchCanStart);
                            self.startGame(username, starting_callback);
                        }
                    }, 100);
                } else {
                    this.$playDiv.unbind('click');
                    this.startGame(username, starting_callback);
                }
            }
        },

        /**
         * Hide the intro parchment and begin the game sequence.
         * On mobile/tablet the map is loaded here (after the transition)
         * instead of in a web worker.
         */
        startGame: function(username, starting_callback) {
            var self = this;

            if(starting_callback) {
                starting_callback();
            }
            this.hideIntro(function() {
                if(!self.isDesktop) {
                    self.game.loadMap();
                }
                self.start(username);
            });
        },

        /**
         * Configure the server connection and launch the game loop.
         * Server options are resolved from the build config based on
         * the current build pragma (dev vs. prod).
         */
        start: function(username) {
            var self = this,
                firstTimePlaying = !self.storage.hasAlreadyPlayed();

            if(username && !this.game.started) {
                var optionsSet = false,
                    cfg = this.config;

                //>>includeStart("devHost", pragmas.devHost);
                if(cfg.local) {
                    log.debug("Starting game with local dev config.");
                    this.game.setServerOptions(cfg.local.host, cfg.local.port, username);
                } else {
                    log.debug("Starting game with default dev config.");
                    this.game.setServerOptions(cfg.dev.host, cfg.dev.port, username);
                }
                optionsSet = true;
                //>>includeEnd("devHost");

                //>>includeStart("prodHost", pragmas.prodHost);
                if(!optionsSet) {
                    log.debug("Starting game with build config.");
                    this.game.setServerOptions(cfg.build.host, cfg.build.port, username);
                }
                //>>includeEnd("prodHost");

                this.center();
                this.game.run(function() {
                    $('body').addClass('started');
                    if(firstTimePlaying) {
                        self.ui.toggleInstructions();
                    }
                });
            }
        },

        // -------------------------------------------------------
        // Intro / parchment transitions
        // -------------------------------------------------------

        hideIntro: function(hidden_callback) {
            clearInterval(this.watchNameInputInterval);
            $('body').removeClass('intro');
            setTimeout(function() {
                $('body').addClass('game');
                hidden_callback();
            }, 1000);
        },

        /**
         * Toggle the play button's disabled state based on the
         * character-name input.  Polled by watchNameInputInterval.
         */
        toggleButton: function() {
            var name = $('#parchment input').val(),
                $play = $('#createcharacter .play');

            if(name && name.length > 0) {
                $play.removeClass('disabled');
                $('#character').removeClass('disabled');
            } else {
                $play.addClass('disabled');
                $('#character').addClass('disabled');
            }
        },

        // -------------------------------------------------------
        // Parchment page transitions (credits / about)
        // -------------------------------------------------------

        /**
         * Toggle credits page.  Behavior differs between pre-game
         * (parchment animation) and in-game (body/parchment class toggle).
         */
        toggleCredits: function() {
            var currentState = $('#parchment').attr('class');

            if(this.game.started) {
                $('#parchment').removeClass().addClass('credits');
                $('body').toggleClass('credits');
                if(!this.game.player) {
                    $('body').toggleClass('death');
                }
                if($('body').hasClass('about')) {
                    this.closeInGameAbout();
                    $('#helpbutton').removeClass('active');
                }
            } else {
                if(currentState !== 'animate') {
                    if(currentState === 'credits') {
                        this.animateParchment(currentState, this.previousState);
                    } else {
                        this.animateParchment(currentState, 'credits');
                        this.previousState = currentState;
                    }
                }
            }
        },

        /**
         * Toggle about page.  Same dual-mode behavior as toggleCredits.
         */
        toggleAbout: function() {
            var currentState = $('#parchment').attr('class');

            if(this.game.started) {
                $('#parchment').removeClass().addClass('about');
                $('body').toggleClass('about');
                if(!this.game.player) {
                    $('body').toggleClass('death');
                }
                if($('body').hasClass('credits')) {
                    this.closeInGameCredits();
                }
            } else {
                if(currentState !== 'animate') {
                    if(currentState === 'about') {
                        if(localStorage && localStorage.data) {
                            this.animateParchment(currentState, 'loadcharacter');
                        } else {
                            this.animateParchment(currentState, 'createcharacter');
                        }
                    } else {
                        this.animateParchment(currentState, 'about');
                        this.previousState = currentState;
                    }
                }
            }
        },

        closeInGameCredits: function() {
            $('body').removeClass('credits');
            $('#parchment').removeClass('credits');
            if(!this.game.player) {
                $('body').addClass('death');
            }
        },

        closeInGameAbout: function() {
            $('body').removeClass('about');
            $('#parchment').removeClass('about');
            if(!this.game.player) {
                $('body').addClass('death');
            }
            $('#helpbutton').removeClass('active');
        },

        /**
         * Close every open panel / overlay.  Delegates in-game panel
         * closing to UIManager; handles credits / about locally.
         */
        hideWindows: function() {
            // UIManager-managed panels
            if(this.ui) {
                if($('#achievements').hasClass('active')) {
                    this.ui.toggleAchievements();
                    $('#achievementsbutton').removeClass('active');
                }
                if($('#instructions').hasClass('active')) {
                    this.ui.toggleInstructions();
                    $('#helpbutton').removeClass('active');
                }
            }
            // App-managed pages
            if($('body').hasClass('credits')) {
                this.closeInGameCredits();
            }
            if($('body').hasClass('about')) {
                this.closeInGameAbout();
            }
        },

        // -------------------------------------------------------
        // Parchment animation utility
        // -------------------------------------------------------

        animateParchment: function(origin, destination) {
            var self = this,
                $parchment = $('#parchment'),
                duration = 1;

            if(this.isMobile) {
                $parchment.removeClass(origin).addClass(destination);
            } else {
                if(this.isParchmentReady) {
                    if(this.isTablet) {
                        duration = 0;
                    }
                    this.isParchmentReady = !this.isParchmentReady;

                    $parchment.toggleClass('animate');
                    $parchment.removeClass(origin);

                    setTimeout(function() {
                        $('#parchment').toggleClass('animate');
                        $parchment.addClass(destination);
                    }, duration * 1000);

                    setTimeout(function() {
                        self.isParchmentReady = !self.isParchmentReady;
                    }, duration * 1000);
                }
            }
        },

        // -------------------------------------------------------
        // Input coordinate tracking
        // -------------------------------------------------------

        setMouseCoordinates: function(event) {
            var gamePos = $('#container').offset(),
                scale = this.game.renderer.getScaleFactor(),
                width = this.game.renderer.getWidth(),
                height = this.game.renderer.getHeight(),
                mouse = this.game.mouse;

            mouse.x = event.pageX - gamePos.left - (this.isMobile ? 0 : 5 * scale);
            mouse.y = event.pageY - gamePos.top - (this.isMobile ? 0 : 7 * scale);

            if(mouse.x <= 0) {
                mouse.x = 0;
            } else if(mouse.x >= width) {
                mouse.x = width - 1;
            }

            if(mouse.y <= 0) {
                mouse.y = 0;
            } else if(mouse.y >= height) {
                mouse.y = height - 1;
            }
        },

        // -------------------------------------------------------
        // Resize coordination
        // -------------------------------------------------------

        /**
         * Called on viewport resize.  Delegates game-canvas resizing
         * to Game and UI resizing to UIManager.
         */
        resizeUi: function() {
            if(this.game) {
                if(this.game.started) {
                    this.game.resize();
                    this.ui.initHealthBar();
                    this.game.updateBars();
                } else {
                    var newScale = this.game.renderer.getScaleFactor();
                    this.game.renderer.rescale(newScale);
                }
            }
        }
    });

    return App;
});
