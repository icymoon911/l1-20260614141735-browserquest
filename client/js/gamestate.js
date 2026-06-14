
/**
 * GameState — the page / UI lifecycle of the client.
 *
 * This is the single place that describes "what screen the player is on".
 * It is owned and driven by App (see app.js): every UI transition enters
 * through App.setState(), and App is the only thing that maps these phases
 * onto the DOM (body classes, parchment, death/error panels).
 *
 * It is deliberately separate from the Game *engine* flags (game.ready /
 * game.started), which describe whether the runtime has finished loading and
 * is ticking. Engine flags are Game's concern; these phases are App's concern.
 * App phases are advanced in response to Game lifecycle events (see
 * wireGameToApp() in main.js).
 *
 *   LOADING ──► READY ──► STARTING ──► PLAYING ──► DEAD ──► PLAYING (respawn)
 *      │          │           │           │          │
 *      └──────────┴───────────┴───────────┴──────────┴──► DISCONNECTED  (fatal)
 *
 *   ERROR is entered before any of the above when the browser cannot run the
 *   game at all (no WebSocket / localStorage); the markup boots straight into
 *   it via index.html, so it has no incoming JS transition here.
 */
define(function() {

    var GameState = {
        LOADING:      'loading',      // intro visible, map + sprites still loading
        READY:        'ready',        // assets ready, PLAY can fire immediately
        STARTING:     'starting',     // PLAY pressed, intro→game transition running
        PLAYING:      'playing',      // player alive in the world
        DEAD:         'dead',         // death parchment shown, awaiting respawn
        DISCONNECTED: 'disconnected', // socket dropped / fatal server error (terminal)
        ERROR:        'error'         // browser cannot run the game (terminal)
    };

    // Legal forward transitions, kept in one table so the flow is auditable
    // without tracing callbacks. A disconnect can happen from any live phase.
    GameState.transitions = {
        loading:      ['ready', 'starting', 'disconnected', 'error'],
        ready:        ['starting', 'disconnected', 'error'],
        starting:     ['playing', 'disconnected'],
        playing:      ['dead', 'disconnected'],
        dead:         ['playing', 'disconnected'],
        disconnected: [],
        error:        []
    };

    /**
     * Whether moving from one phase to another is expected. Staying in the
     * same phase is always allowed. Used by App.setState() to surface illegal
     * jumps in the log instead of failing silently.
     */
    GameState.canTransition = function(from, to) {
        if(from === to) {
            return true;
        }
        var allowed = GameState.transitions[from] || [];
        return allowed.indexOf(to) !== -1;
    };

    return GameState;
});
