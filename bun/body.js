const { arrayBuffer, bytes } = require('./util');

class BodyReader {
  constructor(response, request) {
    this.response = response;
    this.request = request;
    this.started = false;
    this.paused = false;
  }
  onData(callback) {
    this.callback = callback;
    if (!this.started) { this.started = true; queueMicrotask(() => this.read()); }
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; this.wake?.(); this.wake = undefined; }
  cancel() {
    this.resume();
    this.reader?.cancel().catch(() => {});
  }
  async read() {
    try {
      this.reader = this.request.body?.getReader();
      while (!this.response.done) {
        if (this.paused) await new Promise(resolve => { this.wake = resolve; });
        if (this.response.done) break;
        const item = this.reader ? await this.reader.read() : { done: true };
        if (this.response.done) break;
        this.callback(arrayBuffer(item.value), item.done);
        if (item.done) break;
      }
    } catch (error) {
      if (this.request.signal.aborted) this.response.abort();
      else this.response.fail(error);
    } finally {
      this.reader?.releaseLock();
    }
  }
  collect(maxSize, callback) {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    this.onData((chunk, last) => {
      if (exceeded) return;
      size += chunk.byteLength;
      if (size > maxSize) { exceeded = true; callback(null); return; }
      chunks.push(bytes(chunk));
      if (last) callback(arrayBuffer(Buffer.concat(chunks)));
    });
  }
}

module.exports = BodyReader;
