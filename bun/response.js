const BodyReader = require('./body');
const { bytes, text, arrayBuffer, addressBytes, unsupported } = require('./util');

class HttpResponse {
  constructor(request, server, context) {
    this.request = request;
    this.server = server;
    this.context = context;
    this.headers = new Headers();
    this.status = 200;
    this.statusText = 'OK';
    this.offset = 0;
    this.done = false;
    this.body = new BodyReader(this, request);
  }
  active() { if (this.done) throw new Error('HttpResponse is no longer valid'); }
  writeStatus(value) {
    this.active();
    const match = /^(\d{3})(?:\s+(.*))?$/.exec(text(value));
    if (!match) throw new TypeError('Invalid HTTP status');
    this.status = Number(match[1]);
    this.statusText = match[2] ?? '';
    return this;
  }
  writeHeader(name, value) { this.active(); this.headers.append(text(name), text(value)); return this; }
  options() { return { status: this.status, statusText: this.statusText, headers: this.headers }; }
  publishResult(response) { this.result = response; this.ready = true; this.resolve?.(response); }
  getResult() {
    if (this.ready) return this.result;
    this.promise ??= new Promise(resolve => { this.resolve = resolve; });
    return this.promise;
  }
  finish() {
    this.done = true;
    this.request.signal.removeEventListener('abort', this.abortListener);
    this.body.cancel();
  }
  end(value, closeConnection = false) {
    this.active();
    const buffer = bytes(value);
    if (closeConnection) this.headers.set('Connection', 'close');
    if (this.controller) {
      if (buffer.byteLength) { this.controller.enqueue(Buffer.from(buffer)); this.offset += buffer.byteLength; }
      this.controller.close();
    } else {
      const omit = this.request.method === 'HEAD' || [204, 205, 304].includes(this.status);
      this.offset += omit ? 0 : buffer.byteLength;
      this.publishResult(new Response(omit ? null : buffer, this.options()));
    }
    this.finish();
    return this;
  }
  endWithoutBody(length, closeConnection) {
    if (length !== undefined) this.writeHeader('Content-Length', String(length));
    return this.end(undefined, closeConnection);
  }
  beginWrite() { this.active(); this.ensureStream(); return this; }
  ensureStream() {
    if (this.controller) return;
    const stream = new ReadableStream({
      start: controller => { this.controller = controller; },
      pull: () => {
        if (this.writable && !this.done) {
          try { this.writable(this.offset); } catch (error) { this.fail(error); }
        }
      },
      cancel: () => this.abort(),
    }, { highWaterMark: 128 * 1024, size: chunk => chunk.byteLength });
    this.publishResult(new Response(stream, this.options()));
  }
  write(value) {
    this.active();
    this.ensureStream();
    const buffer = Buffer.from(bytes(value));
    this.offset += buffer.byteLength;
    this.controller.enqueue(buffer);
    return this.controller.desiredSize > 0;
  }
  tryEnd(value, totalSize) {
    this.active();
    if (!Number.isSafeInteger(totalSize) || totalSize < 0) throw new TypeError('Invalid response size');
    const buffer = bytes(value);
    if (this.offset + buffer.byteLength > totalSize) throw new RangeError('Response exceeds its declared size');
    if (!this.controller) this.headers.set('Content-Length', String(totalSize));
    const ok = buffer.byteLength ? this.write(buffer) : true;
    const done = this.offset === totalSize;
    if (done) this.end();
    return [ok, done];
  }
  getWriteOffset() { return this.offset; }
  hasResponded() { return this.done; }
  onWritable(callback) { this.active(); this.writable = callback; return this; }
  onAborted(callback) {
    this.active();
    this.abortedCallback = callback;
    if (!this.abortListener) {
      this.abortListener = () => this.abort();
      this.request.signal.addEventListener('abort', this.abortListener, { once: true });
    }
    return this;
  }
  abort() {
    if (this.done) return;
    this.finish();
    this.abortedCallback?.();
    if (!this.ready) this.publishResult(new Response(null, { status: 499 }));
  }
  close() {
    this.active();
    this.ensureStream();
    this.controller.error(new Error('Connection closed'));
    this.abort();
    return this;
  }
  fail(error) {
    if (this.done) return;
    if (this.controller) return this.close();
    this.writeStatus('500 Internal Server Error').end('Internal Server Error');
  }
  onData(callback) { this.active(); this.body.onData(callback); return this; }
  onDataV2(callback) {
    const length = this.request.headers.get('content-length');
    let remaining = length && /^\d+$/.test(length) ? BigInt(length) : (1n << 64n) - 1n;
    let completed = false;
    return this.onData((chunk, last) => {
      if (completed) return;
      remaining = last ? 0n : remaining > BigInt(chunk.byteLength) ? remaining - BigInt(chunk.byteLength) : 0n;
      completed = remaining === 0n;
      callback(chunk, remaining);
    });
  }
  collectBody(maxSize, callback) { this.active(); this.body.collect(maxSize, callback); return this; }
  pause() { this.active(); this.body.pause(); }
  resume() { this.active(); this.body.resume(); }
  cork(callback) { this.active(); callback(); return this; }
  remote() { this.active(); return this.server.requestIP(this.request); }
  getRemoteAddress() { return addressBytes(this.remote()?.address ?? ''); }
  getRemoteAddressAsText() { return arrayBuffer(this.remote()?.address ?? ''); }
  getRemotePort() { return this.remote()?.port ?? 0; }
  getProxiedRemoteAddress() { return unsupported('PROXY protocol'); }
  getProxiedRemoteAddressAsText() { return unsupported('PROXY protocol'); }
  getProxiedRemotePort() { return unsupported('PROXY protocol'); }
  upgrade(userData, key, protocol, extensions, context) {
    this.active();
    if (!context?.behavior) throw new TypeError('A WebSocket context is required');
    const headers = new Headers(this.headers);
    for (const name of ['connection', 'upgrade', 'sec-websocket-accept', 'sec-websocket-extensions']) headers.delete(name);
    if (text(protocol)) headers.set('sec-websocket-protocol', text(protocol).split(',')[0].trim());
    const data = { behavior: context.behavior, app: context.app, userData, remote: this.remote() };
    if (!this.server.upgrade(this.request, { headers, data })) return this.writeStatus('400 Bad Request').end();
    this.publishResult(undefined);
    this.finish();
  }
}

module.exports = HttpResponse;
