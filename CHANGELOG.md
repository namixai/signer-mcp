# Changelog

All notable changes to `@usenami/signer-mcp` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

## [Unreleased]

### Added
- (placeholder)

### Changed
- (placeholder)

### Fixed
- (placeholder)

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
