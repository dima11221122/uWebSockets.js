const { isIP } = require('node:net');

function bytes(value) {
  if (value === undefined) return Buffer.alloc(0);
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected a string, ArrayBuffer, or ArrayBufferView');
}

function text(value) { return typeof value === 'string' ? value : bytes(value).toString(); }
function arrayBuffer(value) {
  const buffer = bytes(value);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
function unsupported(name) { throw new Error(`${name} is not supported by the Bun backend`); }

function addressBytes(address) {
  if (isIP(address) === 4) return Uint8Array.from(address.split('.').map(Number)).buffer;
  if (isIP(address) !== 6) return new ArrayBuffer(0);
  let normalized = address.split('%')[0];
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const parts = normalized.slice(lastColon + 1).split('.').map(Number);
    normalized = normalized.slice(0, lastColon + 1) + ((parts[0] << 8) | parts[1]).toString(16) + ':' + ((parts[2] << 8) | parts[3]).toString(16);
  }
  const halves = normalized.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const result = Buffer.alloc(16);
  groups.forEach((group, index) => result.writeUInt16BE(parseInt(group, 16), index * 2));
  return arrayBuffer(result);
}

function route(pattern, handler, method, order) {
  const names = [];
  const priorities = [];
  const segments = text(pattern).split('/').map(segment => {
    if (segment === '*') { priorities.push(0); return '.*'; }
    if (segment.startsWith(':')) { priorities.push(1); names.push(segment.slice(1)); return '([^/]+)'; }
    priorities.push(2);
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { pattern: text(pattern), handler, method, order, names, priorities, regex: new RegExp('^' + segments.join('/') + '$') };
}

function compareRoutes(a, b) {
  for (let index = 0; index < Math.max(a.priorities.length, b.priorities.length); index++) {
    const delta = (b.priorities[index] ?? 2) - (a.priorities[index] ?? 2);
    if (delta) return delta;
  }
  return Number(a.method === '*') - Number(b.method === '*') || b.order - a.order;
}

function declarative(buffer) {
  const data = new Uint8Array(buffer);
  const instructions = [];
  let offset = 0;
  const read = long => {
    if (offset >= data.length) throw new Error('Truncated declarative response');
    const length = long ? data[offset++] | (data[offset++] << 8) : data[offset++];
    if (offset + length > data.length) throw new Error('Truncated declarative response');
    const value = Buffer.from(data.slice(offset, offset + length));
    offset += length;
    return value;
  };
  while (offset < data.length) {
    const opcode = data[offset++];
    if (opcode === 1) instructions.push([opcode, read(false), read(false)]);
    else if (opcode === 2) instructions.push([opcode]);
    else if ([0, 3, 4, 5, 6, 7].includes(opcode)) instructions.push([opcode, read(opcode === 0 || opcode === 5)]);
    else throw new Error('Invalid declarative response opcode');
  }
  return (res, req) => {
    const parts = [];
    let needsBody = false;
    for (const [opcode, value, second] of instructions) {
      if (opcode === 1) res.writeHeader(value, second);
      else if (opcode === 7) res.writeStatus(value);
      else if (opcode === 2) { needsBody = true; parts.push(null); }
      else if (opcode === 3) parts.push(bytes(req.getQuery(text(value)) ?? ''));
      else if (opcode === 4) parts.push(bytes(req.getHeader(text(value))));
      else if (opcode === 6) parts.push(bytes(req.getParameter(text(value)) ?? ''));
      else parts.push(value);
    }
    if (!needsBody) return res.end(Buffer.concat(parts));
    res.onAborted(() => {});
    const body = [];
    res.onData((chunk, last) => {
      body.push(bytes(chunk));
      if (last) res.end(Buffer.concat(parts.map(part => part ?? Buffer.concat(body))));
    });
  };
}

module.exports = { bytes, text, arrayBuffer, addressBytes, unsupported, route, compareRoutes, declarative };
