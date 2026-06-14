
/**
 * AppStateManager — centralizes the application lifecycle states and their
 * valid transitions so that every state change is explicit and traceable.
 *
 * States
 * ------
 * INTRO          – parchment visible, player hasn't started yet
 * LOADING        – play button pressed, waiting for map / sprites / server
 * RUNNING        – game loop active, player connected
 * DEATH          – player is dead, respawn button shown
 * DISCONNECTED   – connection lost, respawn hidden
 *
 * Typical flow:
 *   INTRO  → LOADING → RUNNING ⇄ DEATH → RUNNING (respawn)
 *                      RUNNING → DISCONNECTED
 */
define(function() {

    // ── state constants (exported on the constructor) ──────────────────────
    var INTRO        = 'intro';
    var LOADING      = 'loading';
    var RUNNING      = 'running';
    var DEATH        = 'death';
    var DISCONNECTED = 'disconnected';

    // ── which transitions are legal ────────────────────────────────────────
    var validTransitions = {};
    validTransitions[INTRO]        = [LOADING];
    validTransitions[LOADING]      = [RUNNING, DISCONNECTED];
    validTransitions[RUNNING]      = [DEATH, DISCONNECTED];
    validTransitions[DEATH]        = [RUNNING, DISCONNECTED];
    validTransitions[DISCONNECTED] = [INTRO];

    // ── constructor ────────────────────────────────────────────────────────
    var AppStateManager = Class.extend({
        init: function() {
            this.currentState = INTRO;
            this.previousState = null;
            this._listeners = [];
        },

        /**
         * Attempt to move to `newState`.  Logs a warning and returns false
         * when the transition is not in the allowed set.
         */
        transition: function(newState) {
            if (this.currentState === newState) {
                return true; // already there — no-op
            }

            var allowed = validTransitions[this.currentState] || [];
            if (allowed.indexOf(newState) === -1) {
                log.warn(
                    "[State] Invalid transition: " +
                    this.currentState + " → " + newState
                );
                return false;
            }

            var from = this.currentState;
            this.previousState = from;
            this.currentState  = newState;

            log.info("[State] " + from + " → " + newState);

            for (var i = 0; i < this._listeners.length; i++) {
                this._listeners[i](newState, from);
            }
            return true;
        },

        is: function(state) {
            return this.currentState === state;
        },

        was: function(state) {
            return this.previousState === state;
        },

        /**
         * Register a listener that fires on every successful transition.
         * Callback signature: function(newState, previousState)
         */
        onTransition: function(callback) {
            this._listeners.push(callback);
        },

        /** Convenience — true when the game loop is live. */
        isGameRunning: function() {
            return this.currentState === RUNNING;
        }
    });

    // ── expose constants as static properties ──────────────────────────────
    AppStateManager.INTRO        = INTRO;
    AppStateManager.LOADING      = LOADING;
    AppStateManager.RUNNING      = RUNNING;
    AppStateManager.DEATH        = DEATH;
    AppStateManager.DISCONNECTED = DISCONNECTED;

    return AppStateManager;
});
