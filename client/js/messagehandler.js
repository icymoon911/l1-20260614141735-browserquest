
/**
 * MessageHandler — Message registry, decoding, and dispatch.
 *
 * Responsibilities:
 *   - Maintain a type → handler registry with category metadata
 *   - Decode inbound wire data (JSON or BISON)
 *   - Distinguish single vs batch messages and dispatch accordingly
 *   - Validate decoded message structure before routing
 *   - Silently drop messages when the listener is disabled
 *   - Catch and log errors in individual handlers without breaking
 *     the dispatch loop
 *
 * This module knows NOTHING about game semantics (entities, combat, etc.).
 * It decodes the wire format and routes each message to its registered
 * handler function.
 *
 * Categories (purely for documentation / debugging):
 *   CONNECTION — Handshake, session lifecycle
 *   ENTITY     — World entity spawn / move / despawn
 *   COMBAT     — Attack, damage, kill
 *   PLAYER     — Player-specific state (health, equip)
 *   UI         — Chat, population, notifications
 *
 * Wire protocol (UNCHANGED):
 *   Single:  [type, field1, field2, ...]
 *   Batch:   [[type, ...], [type, ...], ...]
 */
define(['lib/bison'], function(BISON) {

    var Category = {
        CONNECTION: 'connection',
        ENTITY:     'entity',
        COMBAT:     'combat',
        PLAYER:     'player',
        UI:         'ui'
    };

    var MessageHandler = Class.extend({
        init: function() {
            /**
             * Map of  messageType(Number) → { fn: Function, category: String }
             */
            this.handlers = {};

            this.useBison = false;
            this.enabled = true;
        },

        // ===================================================================
        // Registration
        // ===================================================================

        /**
         * Register a handler for a specific message type.
         *
         * @param {Number}   messageType  One of Types.Messages.*
         * @param {Function} handler      function(data) where data is the
         *                                full decoded array [type, ...]
         * @param {String}   category     One of Category.* (documentation)
         */
        register: function(messageType, handler, category) {
            // Guard: skip undefined types (e.g. SPAWN_BATCH which is not
            // in the protocol — batch messages use nested arrays instead)
            if(messageType === undefined || messageType === null) {
                return;
            }
            this.handlers[messageType] = {
                fn: handler,
                category: category || Category.CONNECTION
            };
        },

        // ===================================================================
        // Inbound processing
        // ===================================================================

        /**
         * Process raw data received from the WebSocket transport.
         * Decodes, validates, and dispatches to the appropriate handler.
         *
         * @param {String|Object} rawData  Raw WebSocket message payload
         */
        handleMessage: function(rawData) {
            if(!this.enabled) {
                log.debug("Message ignored: listener is disabled");
                return;
            }

            var data;
            try {
                if(this.useBison) {
                    data = BISON.decode(rawData);
                } else {
                    data = JSON.parse(rawData);
                }
            } catch(e) {
                log.error("Failed to decode message: " + e + " | data: " + rawData);
                return;
            }

            // All game messages are arrays
            if(!(data instanceof Array)) {
                log.error("Unexpected message format (not an array): " + rawData);
                return;
            }

            if(data.length === 0) {
                log.error("Empty message received, ignoring");
                return;
            }

            log.debug("data: " + rawData);

            if(data[0] instanceof Array) {
                // Batch: [[type, ...], [type, ...], ...]
                this._dispatchBatch(data);
            } else {
                // Single: [type, field1, field2, ...]
                this._dispatchSingle(data);
            }
        },

        // ===================================================================
        // Internal dispatch
        // ===================================================================

        /**
         * Route a single decoded message to its registered handler.
         */
        _dispatchSingle: function(data) {
            var type = data[0],
                entry = this.handlers[type];

            if(entry && typeof entry.fn === 'function') {
                try {
                    entry.fn(data);
                } catch(e) {
                    log.error("Error in handler for message type " +
                              Types.getMessageTypeAsString(type) +
                              " (" + type + "): " + e, true);
                }
            } else {
                log.error("Unhandled message type: " + type);
            }
        },

        /**
         * Dispatch a batch of messages sequentially.
         */
        _dispatchBatch: function(messages) {
            for(var i = 0; i < messages.length; i++) {
                if(messages[i] instanceof Array) {
                    this._dispatchSingle(messages[i]);
                } else {
                    log.error("Invalid batch entry at index " + i +
                              ": expected array, got " + typeof messages[i]);
                }
            }
        },

        // ===================================================================
        // Enable / disable
        // ===================================================================

        /**
         * Enable message processing. Messages are dispatched normally.
         */
        enable: function() {
            this.enabled = true;
        },

        /**
         * Disable message processing. Messages are silently dropped.
         * Used when the player dies and the game is in a "dead" state.
         */
        disable: function() {
            this.enabled = false;
        },

        // ===================================================================
        // Debug helpers
        // ===================================================================

        /**
         * Return a summary of registered handlers (for debugging).
         */
        getRegisteredHandlers: function() {
            var result = [];
            for(var type in this.handlers) {
                if(this.handlers.hasOwnProperty(type)) {
                    result.push({
                        type: Number(type),
                        name: Types.getMessageTypeAsString(Number(type)),
                        category: this.handlers[type].category
                    });
                }
            }
            return result;
        }
    });

    MessageHandler.Category = Category;
    return MessageHandler;
});
