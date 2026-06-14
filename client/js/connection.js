
/**
 * Connection — WebSocket transport lifecycle manager.
 *
 * Responsibilities:
 *   - WebSocket creation (with MozWebSocket fallback)
 *   - State tracking: DISCONNECTED → CONNECTING → CONNECTED → READY
 *   - Dispatcher mode (front-end proxy routing protocol)
 *   - Special protocol signals: "go" (ready) and "timeout" (idle kick)
 *   - Error / close handling with semantic disconnect messages
 *   - Outbound send with readyState guard
 *
 * This module knows NOTHING about game message semantics.
 * It only manages the transport and forwards raw data upward.
 *
 * Flow:
 *   raw WebSocket data  →  Connection.onMessage callback  →  MessageHandler
 */
define([], function() {

    var State = {
        DISCONNECTED: 0,
        CONNECTING:   1,
        CONNECTED:    2,   // WebSocket open, awaiting "go" signal
        READY:        3    // Fully operational
    };

    var Connection = Class.extend({
        init: function() {
            this.state = State.DISCONNECTED;
            this.socket = null;
            this.host = null;
            this.port = null;
            this.isTimeout = false;

            // Callbacks — set via the on* methods below
            this._openCallback      = null;
            this._closeCallback     = null;
            this._errorCallback     = null;
            this._messageCallback   = null;   // raw game data string
            this._readyCallback     = null;   // "go" received
            this._timeoutCallback   = null;   // "timeout" received
            this._dispatchedCallback = null;  // dispatcher reply
        },

        // ===================================================================
        // Connection establishment
        // ===================================================================

        /**
         * Open a WebSocket connection.
         *
         * @param {String}  host            Server hostname
         * @param {Number}  port            Server port
         * @param {Boolean} dispatcherMode  If true, expect a JSON dispatch
         *        reply instead of the normal game protocol handshake.
         */
        connect: function(host, port, dispatcherMode) {
            var url = "ws://" + host + ":" + port + "/";

            this.host = host;
            this.port = port;
            this.state = State.CONNECTING;
            this.isTimeout = false;

            log.info("Trying to connect to server : " + url);

            if(window.MozWebSocket) {
                this.socket = new MozWebSocket(url);
            } else {
                this.socket = new WebSocket(url);
            }

            if(dispatcherMode) {
                this._setupDispatcherMode();
            } else {
                this._setupGameMode();
            }
        },

        // ===================================================================
        // Internal: protocol modes
        // ===================================================================

        /**
         * Dispatcher mode: the first WebSocket reply is a JSON routing
         * instruction telling the client which game server to connect to.
         */
        _setupDispatcherMode: function() {
            var self = this;

            this.socket.onmessage = function(e) {
                var reply;
                try {
                    reply = JSON.parse(e.data);
                } catch(err) {
                    log.error("Failed to parse dispatcher reply: " + err);
                    alert("Unknown error while connecting to BrowserQuest.");
                    return;
                }

                if(reply.status === 'OK') {
                    if(self._dispatchedCallback) {
                        self._dispatchedCallback(reply.host, reply.port);
                    }
                } else if(reply.status === 'FULL') {
                    alert("BrowserQuest is currently at maximum player population. Please retry later.");
                } else {
                    alert("Unknown error while connecting to BrowserQuest.");
                }
            };
        },

        /**
         * Game mode: standard game protocol with "go" handshake.
         *
         * After the WebSocket opens, the server sends "go" to signal
         * readiness.  After that, all messages are game data forwarded
         * to the message callback.
         */
        _setupGameMode: function() {
            var self = this;

            this.socket.onopen = function(e) {
                self.state = State.CONNECTED;
                log.info("Connected to server " + self.host + ":" + self.port);
                if(self._openCallback) {
                    self._openCallback(e);
                }
            };

            this.socket.onmessage = function(e) {
                // --- Protocol-level signals (not game messages) ---

                if(e.data === "go") {
                    self.state = State.READY;
                    if(self._readyCallback) {
                        self._readyCallback();
                    }
                    return;
                }

                if(e.data === 'timeout') {
                    self.isTimeout = true;
                    if(self._timeoutCallback) {
                        self._timeoutCallback();
                    }
                    return;
                }

                // --- Regular game message — forward to handler ---
                if(self._messageCallback) {
                    self._messageCallback(e.data);
                }
            };

            this.socket.onerror = function(e) {
                log.error(e, true);
                if(self._errorCallback) {
                    self._errorCallback(e);
                }
            };

            this.socket.onclose = function() {
                self.state = State.DISCONNECTED;
                log.debug("Connection closed");
                $('#container').addClass('error');

                if(self._closeCallback) {
                    var message;
                    if(self.isTimeout) {
                        message = "You have been disconnected for being inactive for too long";
                    } else {
                        message = "The connection to BrowserQuest has been lost";
                    }
                    self._closeCallback(message);
                }
            };
        },

        // ===================================================================
        // Outbound
        // ===================================================================

        /**
         * Send data over the WebSocket.
         * Silently drops if the socket is not in OPEN state.
         */
        send: function(data) {
            if(this.socket && this.socket.readyState === 1) {
                this.socket.send(data);
            }
        },

        // ===================================================================
        // State queries
        // ===================================================================

        isReady: function() {
            return this.state === State.READY;
        },

        isConnected: function() {
            return this.state >= State.CONNECTED;
        },

        // ===================================================================
        // Callback setters
        // ===================================================================

        onOpen:       function(cb) { this._openCallback = cb; },
        onClose:      function(cb) { this._closeCallback = cb; },
        onError:      function(cb) { this._errorCallback = cb; },
        onMessage:    function(cb) { this._messageCallback = cb; },
        onReady:      function(cb) { this._readyCallback = cb; },
        onTimeout:    function(cb) { this._timeoutCallback = cb; },
        onDispatched: function(cb) { this._dispatchedCallback = cb; }
    });

    Connection.State = State;
    return Connection;
});
