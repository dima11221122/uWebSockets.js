# uWebSockets.js precompiled binaries
Automatically built from source by GitHub Actions. The file "source_commit" contains the corresponding Git commit (SHA-1) that was built. As such you can validate the binaries by diffing against your own build of said commit (using the same compiler).

## Bun backend

This fork adds a Bun backend, selected automatically when `process.versions.bun` is present. It implements the uWebSockets.js JavaScript interface through Bun's native HTTP/WebSocket server. Node continues to use the original precompiled addon. The Bun backend does not load a V8 addon or run a separate libuv loop.

Tested with Bun 1.4.2 on macOS arm64 and Linux amd64, and with Node 24.19.0. Use `bun test` to run the network contract tests. The TLS test generates a temporary self-signed certificate with OpenSSL under ignored `.tmp/`.

Install from `dima11221122/uWebSockets.js#bun-support`. For Ultimate Express, override its transitive `uWebSockets.js` dependency to `github:dima11221122/uWebSockets.js#bun-support` using your package manager's overrides/resolutions, then reinstall and verify the resolved dependency. Pin a commit for reproducible deployments.

The Bun backend supports HTTP routing, status/headers/cookies, request-body callbacks and pause/resume, streamed responses and writable offsets, cancellation, declarative responses, TLS, WebSocket upgrades, binary/text messages, pubsub, and close callbacks. Ultimate Express and Socket.IO can consume the same API.

Compatibility limits:

- Bun controls HTTP stream framing and may use chunked encoding for `tryEnd` responses. Payload size, offsets and completion remain enforced.
- WebSocket compression uses Bun's compression implementation. Native compressor memory-size tuning is not reproduced. Compression, idle timeout, backpressure settings, close-on-backpressure, payload limits and automatic ping settings must be uniform across WebSocket routes. Mixed payload limits are rejected before the server starts, so smaller routes cannot allocate up to another route's limit.
- Nonzero WebSocket `maxLifetime`, `dropped` callbacks, and empty-message publications are unsupported and throw explicit errors. Empty direct sends and pings are supported. Subscription callbacks and user-data identity, including Symbol properties, are preserved.
- TLS DH parameter files and low-memory mode map to Bun options. Custom `ssl_ciphers` restrictions are unsupported and rejected rather than silently ignored.
- Request bodies have a 1 GiB server limit; consumers should enforce their own smaller application limits.
- HTTP/3, fragmented WebSocket sends, PROXY protocol, native descriptors/connection filters, SNI routing, the native shared KV store, and `getParts` are unsupported and throw explicit errors. `_cfg` is a no-op because Bun owns those native settings.
- This is a new compatibility backend; it has not been validated against every upstream example or production workload.

Implementation lives in `bun/`. The upstream license and Node binaries are retained.

See [BENCHMARKS.md](BENCHMARKS.md) for measured application performance, validation and the database-throughput regression.

## Clarification of license

Files in this "binaries" branch are all licensed under Apache License 2.0, despite some of them lacking a notice as per "APPENDIX: How to apply the Apache License to your work" of the Apache License 2.0.
