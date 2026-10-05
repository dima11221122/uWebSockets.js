const HttpRequest = require('./request');
const HttpResponse = require('./response');
const { handlers } = require('./websocket');
const { route, compareRoutes, declarative, text, bytes, unsupported } = require('./util');

class App {
  constructor(options = {}, ssl = false) {
    if (ssl && options.ssl_ciphers !== undefined) unsupported('TLS cipher restrictions');
    this.appOptions = options;
    this.ssl = ssl;
    this.routes = [];
    this.websockets = [];
    this.servers = new Set();
    this.subscribers = new Map();
    this.order = 0;
  }
  add(method, pattern, handler) {
    if (handler instanceof ArrayBuffer) handler = declarative(handler);
    if (typeof handler !== 'function') throw new TypeError('A route handler or declarative response is required');
    this.routes.push(route(pattern, handler, method, this.order++));
    this.routes.sort(compareRoutes);
    return this;
  }
  ws(pattern, behavior) {
    if (behavior.maxLifetime) unsupported('WebSocket maxLifetime');
    if (behavior.dropped) unsupported('WebSocket dropped callbacks');
    const existing = this.websockets[0]?.handler;
    for (const key of ['compression', 'idleTimeout', 'maxBackpressure', 'closeOnBackpressureLimit', 'maxPayloadLength', 'sendPingsAutomatically']) {
      if (existing && existing[key] !== behavior[key]) throw new Error(`Bun requires uniform WebSocket ${key} across routes`);
    }
    this.websockets.push(route(pattern, behavior, 'GET', this.order++));
    this.websockets.sort(compareRoutes);
    return this;
  }
  dispatch(request, server) {
    const req = new HttpRequest(request);
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      for (const candidate of this.websockets) {
        const match = candidate.regex.exec(req.path);
        if (!match) continue;
        req.setRoute(candidate, match);
        const context = { behavior: candidate.handler, app: this };
        const res = new HttpResponse(request, server, context);
        this.invoke(candidate.handler.upgrade ?? ((res, req, context) => res.upgrade({}, req.getHeader('sec-websocket-key'), req.getHeader('sec-websocket-protocol'), '', context)), res, req, context);
        return res.getResult();
      }
    }
    const res = new HttpResponse(request, server);
    for (const candidate of this.routes) {
      if (candidate.method !== '*' && candidate.method !== request.method) continue;
      const match = candidate.regex.exec(req.path);
      if (!match) continue;
      req.setRoute(candidate, match);
      this.invoke(candidate.handler, res, req);
      if (!req.yielded || res.ready) return res.getResult();
    }
    return new Response('', { status: 404 });
  }
  invoke(handler, res, req, context) {
    try {
      const pending = handler(res, req, context);
      if (pending?.then) pending.catch(error => res.fail(error));
    } catch (error) { res.fail(error); }
  }
  serverOptions() {
    const behavior = this.websockets[0]?.handler ?? {};
    const result = {
      fetch: (request, server) => this.dispatch(request, server),
      idleTimeout: 0,
      maxRequestBodySize: 1024 * 1024 * 1024,
    };
    if (this.websockets.length) {
      result.websocket = {
        ...handlers(),
        perMessageDeflate: Boolean(behavior.compression),
        idleTimeout: behavior.idleTimeout ?? 120,
        backpressureLimit: behavior.maxBackpressure ?? 64 * 1024,
        closeOnBackpressureLimit: behavior.closeOnBackpressureLimit ?? false,
        maxPayloadLength: behavior.maxPayloadLength ?? 16 * 1024,
        sendPings: behavior.sendPingsAutomatically ?? true,
      };
    }
    if (this.ssl) {
      if (!this.appOptions.key_file_name || !this.appOptions.cert_file_name) throw new Error('SSLApp requires key_file_name and cert_file_name');
      result.tls = { key: Bun.file(text(this.appOptions.key_file_name)), cert: Bun.file(text(this.appOptions.cert_file_name)) };
      if (this.appOptions.ca_file_name) result.tls.ca = Bun.file(text(this.appOptions.ca_file_name));
      if (this.appOptions.passphrase) result.tls.passphrase = text(this.appOptions.passphrase);
      if (this.appOptions.dh_params_file_name) result.tls.dhParamsFile = text(this.appOptions.dh_params_file_name);
      if (this.appOptions.ssl_prefer_low_memory_usage !== undefined) result.tls.lowMemoryMode = Boolean(this.appOptions.ssl_prefer_low_memory_usage);
    }
    return result;
  }
  listen(...args) {
    const callback = args.pop();
    if (typeof callback !== 'function') throw new TypeError('A listen callback is required');
    const hostname = typeof args[0] === 'number' ? '0.0.0.0' : text(args.shift());
    const port = args.shift();
    let server;
    try {
      server = Bun.serve({ ...this.serverOptions(), hostname, port, reusePort: args[0] === 0 });
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      callback(false);
      return this;
    }
    this.servers.add(server);
    callback({ server });
    return this;
  }
  listen_unix(callback, path) {
    const server = Bun.serve({ ...this.serverOptions(), unix: text(path) });
    this.servers.add(server);
    callback({ server });
    return this;
  }
  close() { for (const server of this.servers) server.stop(true); this.servers.clear(); return this; }
  publish(topic, value, binary = false, compress = false) {
    if (!bytes(value).byteLength) return unsupported('Empty WebSocket publications');
    if (!this.numSubscribers(topic)) return false;
    let sent = false;
    for (const server of this.servers) sent = server.publish(text(topic), binary ? bytes(value) : text(value), compress) !== 0 || sent;
    return sent;
  }
  numSubscribers(topic) { return this.subscribers.get(text(topic)) ?? 0; }
  subscription(topic, delta) {
    const count = this.numSubscribers(topic) + delta;
    if (count > 0) this.subscribers.set(topic, count);
    else this.subscribers.delete(topic);
  }
  getDescriptor() { return unsupported('Native socket descriptors'); }
  filter() { return unsupported('Connection filters'); }
  domain() { return unsupported('TLS server name routing'); }
  addServerName() { return unsupported('TLS server name routing'); }
  removeServerName() { return unsupported('TLS server name routing'); }
  missingServerName() { return unsupported('TLS server name routing'); }
}

for (const [name, method] of Object.entries({ get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE', options: 'OPTIONS', head: 'HEAD', connect: 'CONNECT', trace: 'TRACE', any: '*' })) {
  App.prototype[name] = function(pattern, handler) { return this.add(method, pattern, handler); };
}
module.exports = App;
