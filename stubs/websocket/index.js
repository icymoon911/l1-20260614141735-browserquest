// Minimal websocket stub.
function Request() {}
Request.prototype.readHandshake = function() {};
Request.prototype.accept = function() {
    return { remoteAddress: '127.0.0.1', sendUTF: function(){} };
};
Request.prototype.requestedProtocols = ['websocket-protocol'];
Request.prototype.origin = '';

exports.request = Request;
