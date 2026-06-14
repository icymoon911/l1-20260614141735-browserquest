// Minimal memcache stub for offline / metrics-disabled usage.
function Client() {}
Client.prototype.connect = function() {};
Client.prototype.on      = function() {};
Client.prototype.set     = function(k, v, cb) { if(cb) cb(); };
Client.prototype.get     = function(k, cb)    { if(cb) cb(null, null); };
exports.Client = Client;
