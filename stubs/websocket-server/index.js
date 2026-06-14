// Minimal websocket-server stub.
var events = require('events');

exports.createServer = function() {
    var server = new events.EventEmitter();
    server.server = null;
    server.manager = {};
    server.options = {};
    server.addListener = server.on;
    return server;
};
