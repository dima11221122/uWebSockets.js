const App = require('./app');
const { unsupported } = require('./util');

module.exports = {
  App: options => new App(options),
  SSLApp: options => new App(options, true),
  H3App: () => unsupported('HTTP/3'),
  us_listen_socket_close: socket => socket.server.stop(false),
  us_socket_local_port: socket => socket.server.port,
  LIBUS_LISTEN_EXCLUSIVE_PORT: 1,
  DISABLED: 0,
  SHARED_COMPRESSOR: 1,
  SHARED_DECOMPRESSOR: 256,
  DEDICATED_DECOMPRESSOR: 3840,
  DEDICATED_COMPRESSOR: 248,
  DEDICATED_COMPRESSOR_3KB: 145,
  DEDICATED_COMPRESSOR_4KB: 146,
  DEDICATED_COMPRESSOR_8KB: 163,
  DEDICATED_COMPRESSOR_16KB: 180,
  DEDICATED_COMPRESSOR_32KB: 197,
  DEDICATED_COMPRESSOR_64KB: 214,
  DEDICATED_COMPRESSOR_128KB: 231,
  DEDICATED_COMPRESSOR_256KB: 248,
  DEDICATED_DECOMPRESSOR_32KB: 3840,
  DEDICATED_DECOMPRESSOR_16KB: 3584,
  DEDICATED_DECOMPRESSOR_8KB: 3328,
  DEDICATED_DECOMPRESSOR_4KB: 3072,
  DEDICATED_DECOMPRESSOR_2KB: 2816,
  DEDICATED_DECOMPRESSOR_1KB: 2560,
  DEDICATED_DECOMPRESSOR_512B: 2304,
  _cfg() {},
};
for (const name of ['getString', 'setString', 'getInteger', 'setInteger', 'incInteger', 'lock', 'unlock', 'getIntegerKeys', 'getStringKeys', 'deleteString', 'deleteInteger', 'deleteStringCollection', 'deleteIntegerCollection', 'getParts']) {
  module.exports[name] = () => unsupported(name);
}
