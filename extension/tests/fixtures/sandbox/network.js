// Network, storage and extension globals must be unreachable by name.
db.vars.set("types", {
  fetch: typeof fetch,
  XMLHttpRequest: typeof XMLHttpRequest,
  WebSocket: typeof WebSocket,
  EventSource: typeof EventSource,
  importScripts: typeof importScripts,
  indexedDB: typeof indexedDB,
  chrome: typeof chrome,
});
