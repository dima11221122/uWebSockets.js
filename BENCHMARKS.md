# Bun backend measurements

Measured on 2026-10-05 on an Apple M4 Max (16 CPU cores, 64 GB RAM), macOS arm64, Bun 1.4.2 and Node 24.19.0. The application uses Nest 11.1.10, Express 5.2.1 and Ultimate Express 2.2.1. These are local application measurements, not upstream uWebSockets benchmark claims.

The before configuration is Express on Bun. The after configuration is Ultimate Express on Bun with this fork. Ultimate Express on Node is a control using the unchanged upstream native addon.

## Three-round results

Median requests/second; three alternating rounds, separate Node autocannon client, 2-second warmups and 8-second measured intervals, HTTP/1.1 keep-alive, pipelining 1. Application bundle, middleware, authentication and local PostgreSQL/Redis were retained. Request throttling was disabled for every configuration. Ranges are the minimum and maximum round averages.

| Workload | Connections | Express/Bun before | Ultimate/Bun after | Change | Ultimate/Node control |
|---|---:|---:|---:|---:|---:|
| Metadata | 1 | 10,623 (10,565–10,732) | 12,845 (12,730–13,032) | +20.9% | 11,036 |
| Metadata | 32 | 17,528 (15,869–17,722) | 23,016 (22,928–23,774) | +31.3% | 17,284 |
| Authenticated database request | 1 | 276.25 (275.63–293.25) | 261.63 (188.50–267.88) | −5.3% | 278.25 |
| Authenticated database request | 32 | 1,583.38 (1,560.75–1,583.50) | 1,210.75 (1,209.38–1,216.00) | −23.5% | 1,379.63 |

At 32 connections, median p99 latency was 4 ms for both Bun metadata configurations and 30 ms before / 36 ms after for database requests. Across 36 measurements, 2,331,104 responses were successful, with zero errors, timeouts or non-2xx responses.

This dataset measured implementation revision `e22a12f`. Subsequent review fixes affect upload completion, startup configuration and WebSocket contracts, without changing the measured HTTP GET dispatch/response path. A final four-case confirmation on corrected code returned 13,117 / 22,458 metadata requests/s and 228.63 / 1,234.50 database requests/s at 1 / 32 connections, again with zero errors. It is reported separately rather than mixed into the three-round medians.

## Validation and limits

All 25 real-network contract tests pass on macOS arm64 and Linux amd64 using `oven/bun:1.4.2-slim`. The application integration passes 12 HTTP cases and Socket.IO polling/WebSocket connections. Successful response hashes and selected headers match the prior adapter; malformed JSON still returns 400 but has runtime-specific error wording.

Metadata improves, but database throughput regresses. These results do not support replacing the application's adapter universally. Linux was used for compatibility tests, not performance measurements. WebSocket throughput, production tail latency and memory under sustained slow-client load were not benchmarked. See README for API limits.
