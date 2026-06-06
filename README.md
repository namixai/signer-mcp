# @usenami/signer-mcp

> Sign CEX orders from any MCP-aware AI agent — keys never leave an AWS Nitro Enclave.

`signer-mcp` is the public face of [Usenami Signer](https://usenami.io/signer). It gives Claude Desktop, Cursor, ElizaOS, and any other MCP-aware client a five-tool surface for trading real CEX/DEX accounts (Binance, OKX, Asterdex) without ever loading a private key into the agent's process — or yours.

Status: **v0 (alpha)**. List of venues, attestation, account read, and place/cancel order on testnet.

---

## Why this exists

Every agent framework that touches a CEX today loads the API key into the agent process. That puts the secret on disk, in env vars, in npm packages, in prompt-engineered tool calls, and in your shell history. One prompt injection, one supply-chain compromise, one accidental log line, one curious co-worker — and the key leaks.

Signer takes the opposite approach. The signing key is generated **inside** an AWS Nitro Enclave attested by AWS itself. The enclave's measurement (`PCR0`) is published on `https://usenami.io/signer/attestations`. The MCP server you install here can ask the enclave to sign a specific order — bounded by an explicit policy (per-asset cap, per-period cap, allowed venues) — but it cannot read the key. Neither can the agent, your laptop, your IaC, or our own engineers.

If the agent gets compromised, the worst it can do is place orders inside your policy window. The key itself stays attested.

---

## Quick start (Claude Desktop)

1. **Get a token.** Sign in at [usenami.io/signer](https://usenami.io/signer) and create an API token. The token is bound to a single policy — set per-venue caps before generating it.
2. **Edit `claude_desktop_config.json`.** Path is `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS.

   ```json
   {
     "mcpServers": {
       "signer": {
         "command": "npx",
         "args": ["-y", "@usenami/signer-mcp"],
         "env": {
           "SIGNER_GATEWAY_URL": "https://signer.usenami.io",
           "SIGNER_API_TOKEN": "sk_live_..."
         }
       }
     }
   }
   ```

3. **Restart Claude Desktop** and look for the 🔌 plug icon. You should see five tools listed under `signer`.
4. **Try the read-only tools first.** Ask Claude:
   > "List the venues available through Signer, then return the current attestation document."

   No funds at risk — these don't sign anything.

5. **Once you trust the attestation, place a tiny test order:**
   > "Get my Binance account, then if I have at least $20 of free margin, place a market buy for 0.001 BTC."

If anything looks wrong, the agent can call `cancel_order` immediately.

---

## Quick start (ElizaOS)

ElizaOS agents reach Signer through the generic MCP plugin
[`@elizaos/plugin-mcp`](https://github.com/elizaos-plugins/plugin-mcp) — no
Signer-specific plugin required (a native `@usenami/eliza-plugin-signer` may
come later). Add the plugin and point it at the package over **stdio**:

```bash
npm install @elizaos/plugin-mcp
```

Then in your character / agent config:

```json
{
  "plugins": ["@elizaos/plugin-mcp"],
  "settings": {
    "mcp": {
      "servers": {
        "signer": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@usenami/signer-mcp"],
          "env": {
            "SIGNER_GATEWAY_URL": "https://signer.usenami.io",
            "SIGNER_API_TOKEN": "sk_live_..."
          }
        }
      }
    }
  }
}
```

The agent now exposes the same five tools (`list_venues`, `get_attestation`,
`get_account`, `place_order`, `cancel_order`). Same trust model: the signing key
never enters the Eliza process — start the agent on the read-only tools
(`list_venues` / `get_attestation`) and verify the attestation before letting it
place orders.

---

## Configuration

Environment variables passed via the `env` block of `claude_desktop_config.json` (or your client's equivalent):

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SIGNER_GATEWAY_URL` | no | `https://signer.usenami.io` | Override for self-hosted or staging deployments. |
| `SIGNER_API_TOKEN` | yes (for paid tools) | — | Bearer token issued by usenami.io/signer. `list_venues` works without one; everything else requires it. |
| `SIGNER_FETCH_TIMEOUT_MS` | no | `30000` | Per-request fetch timeout in ms. Lower for CI / smoke tests; raise on slow links. Must be positive integer. |

The MCP server itself stores nothing on disk. Tokens are read from environment on startup and held in memory for the lifetime of the process — kill the agent, the token goes with it.

---

## Tool reference

### `list_venues`

Returns the static manifest of venues this Signer can sign for. **Read-only**, does not contact the gateway, works without a token. Call this first to discover what's supported.

```json
{
  "venues": [
    {
      "venue": "binance",
      "asset_class": "perp",
      "auth_scheme": "hmac_sha256",
      "notes": "..."
    }
  ],
  "count": 1
}
```

### `get_attestation`

Returns the Nitro attestation document for the currently-running enclave. The PCR0 measurement here is what AWS signed when it booted the enclave; you can verify it matches the published build by hashing the corresponding EIF and comparing.

```json
{
  "pcr0": "...sha384 hex...",
  "pcr1": "...",
  "pcr2": "...",
  "signature": "...AWS-issued...",
  "issued_at": "2026-05-31T18:00:00Z"
}
```

Read-only.

### `get_account`

Returns equity, free margin, and open positions for a venue.

```json
{
  "venue": "binance",
  "equity_usd": 145.32,
  "free_margin_usd": 92.10,
  "positions": [
    { "symbol": "BTCUSDT", "qty": 0.002, "entry_price": 67120.5 }
  ],
  "updated_at": "2026-05-31T18:01:11Z"
}
```

Read-only. Requires `SIGNER_API_TOKEN`.

### `place_order`

Place a single market or limit order. The enclave signs the payload after checking policy caps.

Args:
- `venue` — one of `binance | okx | asterdex`
- `symbol` — venue-native symbol (`BTCUSDT`, `BTC-USDT-SWAP`, etc.)
- `side` — `buy` | `sell`
- `qty` — base-asset quantity (e.g. 0.001 for 0.001 BTC). Not USD-notional.
- `type` — `market` | `limit`
- `price` — required if `type=limit`, ignored if `type=market`
- `policy_id` — optional override; defaults to the policy bound to your token

```json
{
  "venue": "binance",
  "order_id": "...",
  "status": "FILLED",
  "filled_qty": 0.001,
  "avg_fill_price": 67128.9,
  "policy_id": "default",
  "attested_at": "..."
}
```

**Destructive.** Requires `SIGNER_API_TOKEN`. v0 routes Binance/OKX to testnet until pilot graduates.

### `cancel_order`

Cancels an outstanding order by its venue order id. Idempotent — cancelling an already-filled or non-existent order returns `ok: false` with a venue reason instead of erroring.

Args:
- `venue` — same enum as `place_order`
- `order_id` — the venue id returned by `place_order`

Requires `SIGNER_API_TOKEN`.

---

## Verifying the attestation

A trustworthy Signer is one whose enclave measurement matches a build you can audit. The workflow:

1. Call `get_attestation` and copy the returned `pcr0`.
2. Visit [usenami.io/signer/attestations](https://usenami.io/signer/attestations).
3. Cross-reference the PCR0 against the published build for the current production version.
4. Optionally rebuild the EIF from source (instructions on the same page) and verify the SHA384 hash yourself.

If the published PCR0 doesn't match what `get_attestation` returns, **don't trade**. Open an issue.

---

## What v0 deliberately does NOT do

v0 keeps the surface deliberately tight:

- No multi-tenant: one account per venue per token.
- No UPL editing UI: policies are set out-of-band on usenami.io/signer.
- No WebSocket / streaming tools — REST only.
- No cross-venue routing (`place_order` takes one venue).
- No leverage configuration (`set_leverage`) — uses account defaults.
- No withdrawals / transfers (closest is `cancel_order`).
- No TWAP / iceberg — single-shot orders only.
- stdio transport only — no SSE or remote HTTP.

If you need any of the above, file an issue describing the use case. v0 keeps the surface tight on purpose.

---

## Development

```bash
# install deps
npm install

# typecheck + build
npm run build

# run from source against staging
SIGNER_GATEWAY_URL=https://staging.signer.usenami.io \
SIGNER_API_TOKEN=sk_test_... \
npm run dev
```

The transport is stdio; you'll need an MCP-aware client to actually exercise the tools. The Anthropic [`mcp-inspector`](https://github.com/modelcontextprotocol/inspector) is the fastest way to poke at it locally.

---

## License

MIT. See [LICENSE](LICENSE).
