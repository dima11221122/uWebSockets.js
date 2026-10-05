const { bytes, text, arrayBuffer, addressBytes, unsupported } = require('./util');

function status(value, empty, blocked) { return value === 0 ? (empty && !blocked ? 1 : 2) : value < 0 ? 0 : 1; }

class WebSocket {
  #socket;
  #data;
  #topics = new Set();
  #closed = false;
  #closing = false;
  constructor(socket) {
    this.#socket = socket;
    this.#data = socket.data;
    for (const key of Reflect.ownKeys(socket.data.userData ?? {})) {
      Object.defineProperty(this, key, { value: socket.data.userData[key], writable: true, enumerable: true, configurable: true });
    }
  }
  #active() { if (this.#closed) throw new Error('WebSocket is no longer valid'); }
  #blocked() { return this.#socket.readyState !== 1 || this.#socket.bufferedAmount > (this.#data.behavior.maxBackpressure ?? 64 * 1024); }
  send(value, binary = false, compress = false) {
    this.#active();
    const blocked = this.#blocked();
    const result = binary ? this.#socket.sendBinary(bytes(value), compress) : this.#socket.sendText(text(value), compress);
    return status(result, bytes(value).byteLength === 0, blocked);
  }
  ping(value = '') { this.#active(); const blocked = this.#blocked(); return status(this.#socket.ping(bytes(value)), bytes(value).byteLength === 0, blocked); }
  getBufferedAmount() { this.#active(); return this.#socket.bufferedAmount; }
  getUserData() { return this; }
  getRemoteAddress() { this.#active(); return addressBytes(this.#data.remote?.address ?? this.#socket.remoteAddress); }
  getRemoteAddressAsText() { this.#active(); return arrayBuffer(this.#data.remote?.address ?? this.#socket.remoteAddress); }
  getRemotePort() { this.#active(); return this.#data.remote?.port ?? 0; }
  #subscription(topic, delta) {
    const previous = this.#data.app.numSubscribers(topic);
    this.#data.app.subscription(topic, delta);
    this.#data.behavior.subscription?.(this, arrayBuffer(topic), previous + delta, previous);
  }
  subscribe(value) {
    this.#active();
    const topic = text(value);
    if (this.#topics.has(topic)) return false;
    const result = this.#socket.subscribe(topic);
    if (result) { this.#topics.add(topic); this.#subscription(topic, 1); }
    return result;
  }
  unsubscribe(value) {
    this.#active();
    const topic = text(value);
    if (!this.#topics.has(topic)) return false;
    const result = this.#socket.unsubscribe(topic);
    if (result) { this.#topics.delete(topic); this.#subscription(topic, -1); }
    return result;
  }
  isSubscribed(value) { this.#active(); return this.#topics.has(text(value)); }
  getTopics() { this.#active(); return [...this.#topics]; }
  publish(topic, value, binary = false, compress = false) {
    this.#active();
    if (!bytes(value).byteLength) return unsupported('Empty WebSocket publications');
    return (binary ? this.#socket.publishBinary(text(topic), bytes(value), compress) : this.#socket.publishText(text(topic), text(value), compress)) !== 0;
  }
  cork(callback) { this.#active(); this.#socket.cork(callback); return this; }
  #notifyClose(code, message) {
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    try {
      for (const topic of this.#topics) {
        try { this.#subscription(topic, -1); } catch { /* Complete cleanup even if user code throws. */ }
      }
    } finally {
      this.#topics.clear();
      this.#closed = true;
      this.#data.behavior.close?.(this, code, arrayBuffer(message));
    }
  }
  static isClosed(adapter) { return adapter.#closed; }
  static notifyClose(adapter, code, message) { adapter.#notifyClose(code, message); }
  end(code = 1000, value = '') {
    this.#active();
    const message = text(value);
    this.#socket.close(code, message);
    this.#notifyClose(code, message);
  }
  close() { this.#active(); this.#socket.terminate(); this.#notifyClose(1006, ''); }
  sendFirstFragment() { return unsupported('WebSocket fragmentation'); }
  sendFragment() { return unsupported('WebSocket fragmentation'); }
  sendLastFragment() { return unsupported('WebSocket fragmentation'); }
}

function handlers() {
  const call = (socket, name, ...args) => {
    try {
      const result = socket.data.behavior[name]?.(socket.data.adapter, ...args);
      if (result?.then) result.catch(() => { if (!WebSocket.isClosed(socket.data.adapter)) socket.data.adapter.end(1011); });
    } catch { if (!WebSocket.isClosed(socket.data.adapter)) socket.data.adapter.end(1011); }
  };
  return {
    open(socket) { socket.data.adapter = new WebSocket(socket); call(socket, 'open'); },
    message(socket, message) {
      const binary = typeof message !== 'string';
      if (bytes(message).byteLength > (socket.data.behavior.maxPayloadLength ?? 16 * 1024)) return socket.data.adapter.end(1009);
      call(socket, 'message', arrayBuffer(message), binary);
    },
    drain(socket) { call(socket, 'drain'); },
    ping(socket, message) { call(socket, 'ping', arrayBuffer(message)); },
    pong(socket, message) { call(socket, 'pong', arrayBuffer(message)); },
    close(socket, code, message) { WebSocket.notifyClose(socket.data.adapter, code, message); },
  };
}

module.exports = { WebSocket, handlers };
