const { bytes, text, arrayBuffer, addressBytes, unsupported } = require('./util');

function status(value) { return value === 0 ? 2 : value < 0 ? 0 : 1; }

class WebSocket {
  constructor(socket) {
    this.socket = socket;
    this.data = socket.data;
    this.topics = new Set();
    this.closed = false;
  }
  active() { if (this.closed) throw new Error('WebSocket is no longer valid'); }
  send(value, binary = false, compress = false) {
    this.active();
    const result = binary ? this.socket.sendBinary(bytes(value), compress) : this.socket.sendText(text(value), compress);
    return status(result);
  }
  ping(value = '') { this.active(); return status(this.socket.ping(bytes(value))); }
  getBufferedAmount() { this.active(); return this.socket.bufferedAmount; }
  getUserData() { return this.data.userData; }
  getRemoteAddress() { this.active(); return addressBytes(this.data.remote?.address ?? this.socket.remoteAddress); }
  getRemoteAddressAsText() { this.active(); return arrayBuffer(this.data.remote?.address ?? this.socket.remoteAddress); }
  getRemotePort() { this.active(); return this.data.remote?.port ?? 0; }
  subscribe(value) {
    this.active();
    const topic = text(value);
    if (this.topics.has(topic)) return false;
    const result = this.socket.subscribe(topic);
    if (result) { this.topics.add(topic); this.data.app.subscription(topic, 1); }
    return result;
  }
  unsubscribe(value) {
    this.active();
    const topic = text(value);
    if (!this.topics.has(topic)) return false;
    const result = this.socket.unsubscribe(topic);
    if (result) { this.topics.delete(topic); this.data.app.subscription(topic, -1); }
    return result;
  }
  isSubscribed(value) { this.active(); return this.topics.has(text(value)); }
  getTopics() { this.active(); return [...this.topics]; }
  publish(topic, value, binary = false, compress = false) {
    this.active();
    return (binary ? this.socket.publishBinary(text(topic), bytes(value), compress) : this.socket.publishText(text(topic), text(value), compress)) !== 0;
  }
  cork(callback) { this.active(); this.socket.cork(callback); return this; }
  notifyClose(code, message) {
    if (this.closed) return;
    this.closed = true;
    for (const topic of this.topics) this.data.app.subscription(topic, -1);
    this.topics.clear();
    this.data.behavior.close?.(this, code, arrayBuffer(message));
  }
  end(code = 1000, value = '') {
    this.active();
    const message = text(value);
    this.socket.close(code, message);
    this.notifyClose(code, message);
  }
  close() { this.active(); this.socket.terminate(); this.notifyClose(1006, ''); }
  sendFirstFragment() { return unsupported('WebSocket fragmentation'); }
  sendFragment() { return unsupported('WebSocket fragmentation'); }
  sendLastFragment() { return unsupported('WebSocket fragmentation'); }
}

function handlers() {
  const call = (socket, name, ...args) => {
    try {
      const result = socket.data.behavior[name]?.(socket.data.adapter, ...args);
      if (result?.then) result.catch(() => { if (!socket.data.adapter.closed) socket.data.adapter.end(1011); });
    } catch { if (!socket.data.adapter.closed) socket.data.adapter.end(1011); }
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
    close(socket, code, message) { socket.data.adapter.notifyClose(code, message); },
  };
}

module.exports = { WebSocket, handlers };
