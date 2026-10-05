const { test, expect, afterEach } = require('bun:test');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const uws = require('../uws.js');
const apps = new Set();

async function listen(app) {
  apps.add(app);
  const socket = await new Promise(resolve => app.listen('127.0.0.1', 0, resolve));
  expect(socket).toBeTruthy();
  return `http://127.0.0.1:${uws.us_socket_local_port(socket)}`;
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(url, options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

function tlsFixtures() {
  const directory = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(directory, { recursive: true });
  const key = path.join(directory, 'test-key.pem');
  const cert = path.join(directory, 'test-cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  }
  return { key_file_name: key, cert_file_name: cert };
}

afterEach(() => {
  for (const app of apps) app.close();
  apps.clear();
});

test('routes literal, parameter and wildcard paths with method and yield semantics', async () => {
  const app = uws.App();
  app.any('/*', res => res.writeStatus('404 Not Found').end('fallback'));
  app.get('/users/:id', (res, req) => res.end(req.getParameter(0)));
  app.get('/users/me', res => res.end('literal'));
  app.any('/method', res => res.end('any'));
  app.post('/method', res => res.end('post'));
  app.get('/yield', (res, req) => req.setYield(true));
  const base = await listen(app);
  expect(await (await fetch(base + '/users/me')).text()).toBe('literal');
  expect(await (await fetch(base + '/users/42')).text()).toBe('42');
  expect(await (await fetch(base + '/method', { method: 'POST' })).text()).toBe('post');
  expect((await fetch(base + '/yield')).status).toBe(404);
});

test('preserves query, headers, status, cookies, and binary views', async () => {
  const app = uws.App().get('/echo/:id', (res, req) => {
    const headers = {};
    req.forEach((key, value) => { headers[key] = value; });
    res.writeStatus('201 Created').writeHeader('Content-Type', 'application/json');
    res.writeHeader('Set-Cookie', 'a=1').writeHeader('Set-Cookie', 'b=2');
    res.end(JSON.stringify({ url: req.getUrl(), query: req.getQuery(), value: req.getQuery('q'), missing: req.getHeader('missing'), method: req.getCaseSensitiveMethod(), id: req.getParameter('id'), header: headers['x-test'] }));
  }).get('/view', res => res.end(new Uint8Array([0, 1, 2, 3]).subarray(1, 3)));
  const base = await listen(app);
  const response = await request(base + '/echo/42?q=a%20b&n=2', { headers: { 'x-test': 'value' } });
  expect(response.status).toBe(201);
  expect(response.headers['set-cookie']).toEqual(['a=1', 'b=2']);
  expect(JSON.parse(response.body)).toEqual({ url: '/echo/42', query: 'q=a%20b&n=2', value: 'a b', missing: '', method: 'GET', id: '42', header: 'value' });
  expect((await request(base + '/view')).body).toEqual(Buffer.from([1, 2]));
});

test('HEAD, 204 and 304 omit bodies and retain declared headers', async () => {
  const app = uws.App().head('/head', res => res.endWithoutBody(123));
  app.get('/empty', res => res.writeStatus('204 No Content').end());
  app.get('/cached', res => res.writeStatus('304 Not Modified').writeHeader('ETag', 'test').end());
  const base = await listen(app);
  const head = await request(base + '/head', { method: 'HEAD' });
  expect(head.headers['content-length']).toBe('123');
  expect(head.body.length).toBe(0);
  expect((await request(base + '/empty')).status).toBe(204);
  const cached = await request(base + '/cached');
  expect(cached.status).toBe(304);
  expect(cached.headers.etag).toBe('test');
});

test('delivers request chunks with a final callback and pause/resume', async () => {
  const app = uws.App().post('/body', res => {
    res.onAborted(() => {});
    const chunks = [];
    let paused = false;
    res.onData((chunk, last) => {
      chunks.push(Buffer.from(chunk));
      if (!last && !paused) {
        paused = true;
        res.pause();
        setTimeout(() => res.resume(), 5);
      }
      if (last) res.end(Buffer.concat(chunks));
    });
  });
  const base = await listen(app);
  const body = Buffer.alloc(512 * 1024, 0x61);
  expect((await request(base + '/body', { method: 'POST', body })).body).toEqual(body);
});

test('streams a fixed-size response with offsets and backpressure without corruption', async () => {
  const size = 4 * 1024 * 1024;
  const body = Buffer.alloc(size, 0x62);
  let sawBackpressure = false;
  const app = uws.App().get('/stream', res => {
    res.onAborted(() => {});
    const send = offset => {
      while (offset < size) {
        const chunk = body.subarray(offset, Math.min(offset + 65536, size));
        const [ok, done] = res.tryEnd(chunk, size);
        offset = res.getWriteOffset();
        if (done) return true;
        if (!ok) { sawBackpressure = true; return false; }
      }
      return true;
    };
    res.onWritable(send);
    send(0);
  });
  const base = await listen(app);
  const result = await request(base + '/stream');
  // Bun controls stream framing; both fixed length and chunked are valid HTTP/1.1.
  expect(result.headers['content-length'] === String(size) || result.headers['transfer-encoding'] === 'chunked').toBe(true);
  expect(result.body).toEqual(body);
  expect(sawBackpressure).toBe(true);
});

test('chunked output and asynchronous responses preserve the body', async () => {
  const app = uws.App().get('/chunks', res => {
    res.onAborted(() => {});
    res.writeHeader('x-test', 'stream').write('first');
    setTimeout(() => res.end('last'), 5);
  });
  const base = await listen(app);
  expect((await request(base + '/chunks')).body.toString()).toBe('firstlast');
});

test('client abort invokes onAborted once and does not use the response again', async () => {
  let aborted = 0;
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  const app = uws.App().get('/abort', res => {
    res.onAborted(() => { aborted++; ready(); });
    res.write('started');
  });
  const base = await listen(app);
  await new Promise((resolve, reject) => {
    const req = http.get(base + '/abort', res => {
      res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
    });
    req.on('error', reject);
  });
  await Promise.race([waiting, new Promise((_, reject) => setTimeout(() => reject(new Error('abort callback missing')), 1000))]);
  expect(aborted).toBe(1);
});

test('declarative bytecode interpolates parameters and decoded query values', async () => {
  const response = new uws.DeclarativeResponse().writeHeader('x-declarative', 'yes').write('hello ').writeParameterValue('name').write('/').writeQueryValue('q').end('!');
  const base = await listen(uws.App().get('/hello/:name', response));
  const result = await request(base + '/hello/alice?q=a%20b');
  expect(result.headers['x-declarative']).toBe('yes');
  expect(result.body.toString()).toBe('hello alice/a b!');
});

test('WebSocket upgrade preserves user data, text/binary frames, pubsub and close callbacks', async () => {
  let closed = 0;
  let notifyClosed;
  const serverClosed = new Promise(resolve => { notifyClosed = resolve; });
  const app = uws.App().ws('/ws', {
    upgrade(res, req, context) {
      res.upgrade({ name: req.getQuery('name') }, req.getHeader('sec-websocket-key'), '', '', context);
    },
    open(ws) { ws.subscribe('room'); ws.send(ws.getUserData().name); },
    message(ws, message, binary) { ws.send(message, binary); },
    close() { closed++; notifyClosed(); },
  });
  const base = await listen(app);
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws?name=alice');
  ws.binaryType = 'arraybuffer';
  const received = [];
  ws.onmessage = event => received.push(event.data);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.send('text');
  ws.send(new Uint8Array([1, 2, 3]));
  await Bun.sleep(30);
  expect(received[0]).toBe('alice');
  expect(received[1]).toBe('text');
  expect(new Uint8Array(received[2])).toEqual(new Uint8Array([1, 2, 3]));
  expect(app.numSubscribers('room')).toBe(1);
  expect(app.publish('room', 'broadcast')).toBe(true);
  await Bun.sleep(10);
  expect(received.at(-1)).toBe('broadcast');
  await new Promise(resolve => { ws.onclose = resolve; ws.close(); });
  await serverClosed;
  expect(closed).toBe(1);
  expect(app.numSubscribers('room')).toBe(0);
});

test('WebSocket user data lives on the socket without colliding with internal state', async () => {
  const symbol = Symbol('user data');
  let finish;
  const closed = new Promise(resolve => { finish = resolve; });
  const app = uws.App().ws('/identity', {
    upgrade(res, req, context) {
      res.upgrade({ name: 'alice', socket: 'user socket', data: 'user data', topics: 'user topics', closed: 'user closed', [symbol]: 'symbol data' }, req.getHeader('sec-websocket-key'), '', '', context);
    },
    open(ws) {
      const same = ws.getUserData() === ws;
      ws.name = 'bob';
      ws.getUserData().added = 'shared';
      ws.subscribe('identity');
      const fields = Object.fromEntries(['socket', 'data', 'topics', 'closed'].map(key => [key, typeof ws[key] === 'string' ? ws[key] : null]));
      ws.send(JSON.stringify({ same, name: ws.getUserData().name, added: ws.added, symbol: ws[symbol], ...fields }));
    },
    close: finish,
  });
  const base = await listen(app);
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/identity');
  const result = await new Promise((resolve, reject) => { ws.onmessage = event => resolve(JSON.parse(event.data)); ws.onerror = reject; });
  ws.close();
  await closed;
  expect(result).toEqual({ same: true, name: 'bob', added: 'shared', symbol: 'symbol data', socket: 'user socket', data: 'user data', topics: 'user topics', closed: 'user closed' });
  expect(app.numSubscribers('identity')).toBe(0);
});

test('subscription callbacks report topic counts for subscribe, unsubscribe and disconnect', async () => {
  const changes = [];
  let finalTopics;
  let finish;
  const closed = new Promise(resolve => { finish = resolve; });
  const base = await listen(uws.App().ws('/subscriptions', {
    open(ws) { ws.subscribe('room'); ws.unsubscribe('room'); ws.subscribe('room'); ws.send('ready'); },
    subscription(ws, topic, next, previous) {
      changes.push([Buffer.from(topic).toString(), next, previous]);
      finalTopics = ws.getTopics();
    },
    close: finish,
  }));
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/subscriptions');
  await new Promise((resolve, reject) => { ws.onmessage = resolve; ws.onerror = reject; });
  ws.close();
  await closed;
  expect(changes).toEqual([['room', 1, 0], ['room', 0, 1], ['room', 1, 0], ['room', 0, 1]]);
  expect(finalTopics).toEqual(['room']);
});

test('empty WebSocket sends and pings report success and are delivered', async () => {
  let finish;
  const closed = new Promise(resolve => { finish = resolve; });
  let pingDelivered;
  const pong = new Promise(resolve => { pingDelivered = resolve; });
  const received = [];
  const base = await listen(uws.App().ws('/empty-frames', {
    open(ws) {
      const statuses = [ws.send(''), ws.send(new Uint8Array(0), true), ws.ping()];
      ws.send(JSON.stringify(statuses));
    },
    pong: pingDelivered,
    close: finish,
  }));
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/empty-frames');
  ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => { ws.onmessage = event => { received.push(event.data); if (received.length === 3) resolve(); }; ws.onerror = reject; });
  await pong;
  ws.close();
  await closed;
  expect(received[0]).toBe('');
  expect(received[1].byteLength).toBe(0);
  expect(JSON.parse(received[2])).toEqual([1, 1, 1]);
});

test('WebSocket settings are mapped or rejected instead of silently ignored', () => {
  expect(() => uws.App().ws('/a', { maxPayloadLength: 16 }).ws('/b', { maxPayloadLength: 32 })).toThrow('uniform WebSocket maxPayloadLength');
  expect(() => uws.App().ws('/a', { sendPingsAutomatically: false }).ws('/b', { sendPingsAutomatically: true })).toThrow('uniform WebSocket sendPingsAutomatically');
  expect(() => uws.App().ws('/a', { maxLifetime: 1 })).toThrow('not supported');
  expect(() => uws.App().ws('/a', { dropped() {} })).toThrow('not supported');
});

test('empty WebSocket publications fail explicitly', async () => {
  let finish;
  const closed = new Promise(resolve => { finish = resolve; });
  let socket;
  const app = uws.App().ws('/publish-empty', {
    open(ws) { socket = ws; ws.subscribe('room'); ws.send('ready'); },
    close: finish,
  });
  const base = await listen(app);
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/publish-empty');
  await new Promise((resolve, reject) => { ws.onmessage = resolve; ws.onerror = reject; });
  expect(() => app.publish('room', '')).toThrow('not supported');
  expect(() => socket.publish('room', new Uint8Array(0), true)).toThrow('not supported');
  ws.close();
  await closed;
});

test('RecognizedString listen hosts accept buffer and ArrayBuffer overloads', async () => {
  for (const host of [Buffer.from('127.0.0.1'), new TextEncoder().encode('127.0.0.1').buffer]) {
    const app = uws.App().get('/', res => res.end('host'));
    apps.add(app);
    const socket = await new Promise(resolve => app.listen(host, 0, resolve));
    expect((await request(`http://127.0.0.1:${uws.us_socket_local_port(socket)}/`)).body.toString()).toBe('host');
  }
});

test('unsupported TLS cipher restrictions are rejected and DH files are not ignored', async () => {
  expect(() => uws.SSLApp({ ssl_ciphers: 'restricted' })).toThrow('not supported');
  const options = tlsFixtures();
  const base = (await listen(uws.SSLApp(options).get('/', res => res.end('valid TLS')))).replace('http:', 'https:');
  expect((await request(base + '/', { rejectUnauthorized: false })).body.toString()).toBe('valid TLS');
  const app = uws.SSLApp({ ...options, dh_params_file_name: '/missing-dh-params.pem' });
  apps.add(app);
  expect(() => app.listen('127.0.0.1', 0, () => {})).toThrow();
});

test('registers OPTIONS without shadowing the method with app settings', async () => {
  const base = await listen(uws.App().options('/cors', res => res.writeStatus('204 No Content').writeHeader('access-control-allow-origin', '*').end()));
  const response = await request(base + '/cors', { method: 'OPTIONS' });
  expect(response.status).toBe(204);
  expect(response.headers['access-control-allow-origin']).toBe('*');
});

test('a complete tryEnd has the declared size and can be sent without stream framing', async () => {
  const base = await listen(uws.App().get('/small', res => {
    expect(res.tryEnd('hello', 5)).toEqual([true, true]);
  }));
  const response = await request(base + '/small');
  expect(response.body.toString()).toBe('hello');
  expect(response.headers['content-length']).toBe('5');
});

test('body collection reports overflow once and replaced onData handlers receive delivery', async () => {
  let overflow = 0;
  const app = uws.App().post('/limit', res => {
    res.onAborted(() => {});
    res.collectBody(3, body => {
      if (body === null) { overflow++; res.writeStatus('413 Payload Too Large').end(); }
    });
  }).post('/replace', res => {
    res.onAborted(() => {});
    res.onData(() => { throw new Error('old handler called'); });
    const chunks = [];
    res.onData((chunk, last) => { chunks.push(Buffer.from(chunk)); if (last) res.end(Buffer.concat(chunks)); });
  });
  const base = await listen(app);
  expect((await request(base + '/limit', { method: 'POST', body: 'too long' })).status).toBe(413);
  expect(overflow).toBe(1);
  expect((await request(base + '/replace', { method: 'POST', body: 'replacement' })).body.toString()).toBe('replacement');
});

test('onDataV2 completes a fixed-length upload once when the response is asynchronous', async () => {
  let completions = 0;
  const chunks = [];
  const base = await listen(uws.App().post('/v2', res => {
    res.onAborted(() => {});
    res.onDataV2((chunk, remaining) => {
      chunks.push(Buffer.from(chunk));
      if (remaining === 0n && ++completions === 1) setTimeout(() => res.end('ok'), 10);
    });
  }));
  const body = Buffer.alloc(256 * 1024, 0x76);
  expect((await request(base + '/v2', { method: 'POST', headers: { 'content-length': body.length }, body })).body.toString()).toBe('ok');
  expect(Buffer.concat(chunks)).toEqual(body);
  expect(completions).toBe(1);
});

test('listen conflicts return false and close releases the port', async () => {
  const app = uws.App().get('/*', res => res.end('ok'));
  const base = await listen(app);
  const port = Number(new URL(base).port);
  const other = uws.App();
  apps.add(other);
  expect(await new Promise(resolve => other.listen('127.0.0.1', port, resolve))).toBe(false);
  app.close();
  expect(await new Promise(resolve => other.listen('127.0.0.1', port, resolve))).toBeTruthy();
});

test('copies an ended body before the caller reuses its buffer', async () => {
  const base = await listen(uws.App().get('/copy', res => {
    const body = Buffer.from('original');
    res.end(body);
    body.fill(0);
  }));
  expect((await request(base + '/copy')).body.toString()).toBe('original');
});

test('client disconnect before headers invokes onAborted without waiting for an application response', async () => {
  let started;
  let closed;
  const start = new Promise(resolve => { started = resolve; });
  const abort = new Promise(resolve => { closed = resolve; });
  const base = await listen(uws.App().get('/pending', res => {
    res.onAborted(closed);
    started();
  }));
  const req = http.get(base + '/pending');
  req.on('error', () => {});
  await start;
  req.destroy();
  await Promise.race([abort, new Promise((_, reject) => setTimeout(() => reject(new Error('pending response abort missing')), 1000))]);
});

test('serves TLS through SSLApp', async () => {
  const base = (await listen(uws.SSLApp({ ...tlsFixtures(), ssl_prefer_low_memory_usage: true }).get('/tls', res => res.end('secure')))).replace('http:', 'https:');
  expect((await request(base + '/tls', { rejectUnauthorized: false })).body.toString()).toBe('secure');
});

test('rejects native-only features explicitly', () => {
  expect(() => uws.H3App()).toThrow('not supported');
  expect(() => uws.App().filter(() => {})).toThrow('not supported');
  expect(() => uws.getString('key')).toThrow('not supported');
});
