# Changelog

All notable changes to `@usenami/signer-mcp` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

## [Unreleased]

### Added
- (placeholder)

### Changed
- (placeholder)

### Fixed
- (placeholder)

## [0.2.0] — 2026-06-07 (all 6 venues)

`list_venues` now reports all six venues the Signer gateway can sign for (was 3).

### Added
- **kucoin** — KuCoin Futures perp (HMAC-SHA256 + KuCoin v2 encrypted
  passphrase). Symbol format `XBTUSDTM` (contract code; qty in contracts).
  Account parser handles the `account-overview` + `positions` composite.
- **bybit** — Bybit V5 linear perp (HMAC-SHA256, `category=linear`). Symbol
  format `BTCUSDT`. Account parser handles the `wallet-balance` +
  `position/list` composite; position sign derived from `side`.
- **hyperliquid_main** — Hyperliquid L1 perp (EIP-712 action signing). Symbol
  format is the bare coin name, e.g. `BTC`. Account parser handles the
  single `clearinghouseState` payload (signed szi → position direction).

### Changed
- `list_venues` count 3 → 6; `place_order` / `get_account` / `cancel_order`
  accept the three new venue ids (the venue enum is derived from the manifest).
- README venue table, smoke test, and server.json manifest updated for 6 venues.

### Notes
- Live `get_account` is wired end-to-end for venues whose gateway account-read
  path is enabled (binance/okx today). For kucoin/bybit/hyperliquid_main the
  MCP-side read-only path (signed-request submit + response parser) is in place
  and unit-tested; it activates as the gateway enables each account endpoint.
  Order signing already works for all six (gateway verify-all-blobs 6/6).

## [0.1.1] — 2026-06-06 (metadata republish)

No code or behavior changes vs `0.1.0`. Republished so the npm registry picks up
the corrected package metadata that landed in monorepo PR #557:

### Changed
- `repository.url` now points at the standalone public mirror
  `https://github.com/namixai/signer-mcp.git` (was the private monorepo).
- `bugs.url` likewise repointed to the public repo's issues page.
- README updated with the ElizaOS Quick Start section + standalone-repo links.

## [0.1.0] — 2026-06-05 (first publish)

Initial release. Five MCP tools backed by the Usenami Signer gateway, with keys that never leave an AWS Nitro Enclave.

### Added
- `list_venues` — read-only static manifest of supported venues (binance/okx/asterdex).
- `get_attestation` — Nitro PCR0 + AWS signature proving the running enclave matches the published build.
- `get_account` — equity / free margin / positions for a venue (Option-A: gateway returns signed read request, MCP submits + parses).
- `place_order` — single market or limit order on Binance USD-M Futures, OKX v5 perpetual swap, or Asterdex BSC perp. Signed inside the enclave; per-asset signature caps enforced server-side.
- `cancel_order` — cancel an outstanding order by venue + order_id (+ optional `symbol` for Binance/OKX cancel routes).

### Known limits (deliberate, see README §"What v0 deliberately does NOT do")
- stdio transport only — no SSE/HTTP.
- single account per venue per `SIGNER_API_TOKEN`.
- no withdrawals / transfers / leverage configuration / multi-venue routing / streaming.
- per-period rate caps (`$X / hour`) NOT enforced — documented gap; deferred to stateful-UPL work.

### Configuration
- `SIGNER_GATEWAY_URL` (default `https://signer.usenami.io`).
- `SIGNER_API_TOKEN` (required for everything except `list_venues`).
- `SIGNER_FETCH_TIMEOUT_MS` (default 30000ms).
