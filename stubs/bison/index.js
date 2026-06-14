// Minimal BISON stub – the server uses JSON by default (useBison = false).
exports.encode = function(obj) { return JSON.stringify(obj); };
exports.decode = function(str) { return JSON.parse(str); };
