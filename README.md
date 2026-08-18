# @usenami/signer-mcp

> Sign CEX orders from any MCP-aware AI agent — keys never leave an AWS Nitro Enclave.

`signer-mcp` is the public face of [Usenami Signer](https://usenami.io/signer). It gives Claude Desktop, Cursor, ElizaOS, and any other MCP-aware client a six-tool surface for trading real CEX/DEX perp accounts (Binance, OKX, Asterdex, KuCoin, Bybit, Hyperliquid) without ever loading a private key into the agent's process — or yours.

Status: **v0 (alpha), invite-based pilot**. Venue manifest, attestation, account read, place/cancel order, and a two-leg hedge. ⚠️ **Orders are real**: which venue and network your orders hit is decided by the policy bound to your token, and on Binance the hosted deployment signs **mainnet orders with real funds** (it has since 2026-07-27). There is no implicit testnet safety net — read [`place_order`](#place_order) before sending anything.

---

## Why this exists

Every agent framework that touches a CEX today loads the API key into the agent process. That puts the secret on disk, in env vars, in npm packages, in prompt-engineered tool calls, and in your shell history. One prompt injection, one supply-chain compromise, one accidental log line, one curious co-worker — and the key leaks.

Signer takes the opposite approach. The signing key is generated **inside** an AWS Nitro Enclave attested by AWS itself. The enclave's measurement (`PCR0`) is published on `https://usenami.io/signer/attestations`. The MCP server you install here can ask the enclave to sign a specific order — bounded by an explicit policy (per-asset cap, per-period cap, allowed venues) — but it cannot read the key. Neither can the agent, your laptop, your IaC, or our own engineers.

If the agent gets compromised, the worst it can do is place orders inside your policy window. The key itself stays attested.

---

## Quick start (Claude Desktop)

1. **Get a token.** Access is **invite-based** during the pilot — there is no self-serve signup yet; request access via [usenami.io/signer](https://usenami.io/signer) (contact link at the bottom) and your token is provisioned at onboarding, bound to a policy with per-venue caps. **No token yet?** Steps 2–4 still work: `list_venues` and `get_attestation` need no token. Note what each one actually does, because only one of them talks to us: `get_attestation` fetches a live, NSM-signed document **from the gateway**, while `list_venues` answers from a static manifest compiled into this package and makes **no network call at all**.
2. **Edit `claude_desktop_config.json`.** Path is `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS.

   ```json
   {
     "mcpServers": {
       "signer": {
         "command": "npx",
         "args": ["-y", "@usenami/signer-mcp@^0.6.0"],
         "env": {
           "SIGNER_GATEWAY_URL": "https://signer-demo.usenami.io:8443",
           "SIGNER_API_TOKEN": "sk_live_..."
         }
       }
     }
   }
   ```

> **Pin `@^0.6.0` — earlier versions do not work out of the box.** Every published version up to
> and including `0.5.0` defaults `SIGNER_GATEWAY_URL` to `https://signer.usenami.io`, which
> `301`-redirects every path to the marketing landing page. The network tools then receive HTML
> and die with `Unexpected token '<'`. `0.6.0` changed the default to the demo gateway. If you
> are pasting a config from an older post or cached answer, check this first — the symptom looks
> like a broken server and is a stale default.

3. **Restart Claude Desktop** and look for the 🔌 plug icon. You should see six tools listed under `signer`.
4. **Try the read-only tools first.** Ask Claude:
   > "List the venues available through Signer, then return the current attestation document."

   No funds at risk — these don't sign anything, and neither needs a token.

5. **Once you have a token and trust the attestation, you can place a first order — knowingly.**
   ⚠️ This signs a **real order on the venue your token's policy allows**. For Binance in
   the hosted deployment that means **mainnet, real money** — 0.001 BTC is a real position,
   not a testnet exercise. Check `list_venues` `status`/`notes` for the venue first, start
   with the smallest size your policy allows, and only then:
   > "Get my Binance account, then if I have at least $20 of free margin, place a market buy for 0.001 BTC."

If anything looks wrong, the agent can call `cancel_order` immediately.

---

## Quick start (ElizaOS)

ElizaOS has a **native plugin**:
[`@usenami/plugin-signer`](https://www.npmjs.com/package/@usenami/plugin-signer)
(same gateway contract — a token issued for one works with the other). Prefer it:
actions land directly in the agent, plus an attestation provider that keeps the
current PCR0 in context.

Alternatively, ElizaOS can reach this MCP server through the generic bridge
[`@elizaos/plugin-mcp`](https://github.com/elizaos-plugins/plugin-mcp) over **stdio**:

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
          "args": ["-y", "@usenami/signer-mcp@^0.6.0"],
          "env": {
            "SIGNER_GATEWAY_URL": "https://signer-demo.usenami.io:8443",
            "SIGNER_API_TOKEN": "sk_live_..."
          }
        }
      }
    }
  }
}
```

The agent now exposes the same six tools (`list_venues`, `get_attestation`,
`get_account`, `place_order`, `place_hedge`, `cancel_order`). Same trust model: the signing key
never enters the Eliza process — start the agent on the read-only tools
(`list_venues` / `get_attestation`) and verify the attestation before letting it
place orders. Only `get_attestation` reaches the gateway; `list_venues` is served from a
static manifest inside the package, so a green `list_venues` says nothing about whether
your gateway is reachable.

---

## Configuration

Environment variables passed via the `env` block of `claude_desktop_config.json` (or your client's equivalent):

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SIGNER_GATEWAY_URL` | no | `https://signer-demo.usenami.io:8443` | The hosted attested demo enclave. Override for self-hosted deployments. |
| `SIGNER_API_TOKEN` | yes (for account/order tools) | — | Bearer token provisioned at onboarding (invite-based pilot). `list_venues` **and** `get_attestation` work without one — but only `get_attestation` contacts the gateway (`list_venues` is static, see its section below); `get_account`, `place_order`, `place_hedge`, `cancel_order` require it. |
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
      "status": "live",
      "notes": "..."
    }
  ],
  "count": 7
}
```

Every entry carries a `status`: `live` (the enclave will sign for it) or `denied`
(the enclave refuses by policy — supplying credentials will not change it). Some
entries add a `network` field (`bsc`, `hyperliquid-testnet`, …). **Read `status`
and `notes` before choosing a venue.**

#### Supported venues

| `venue` id          | status | asset class | auth scheme   | symbol example  | notes |
|---------------------|--------|-------------|---------------|-----------------|-------|
| `binance`           | live   | perp        | hmac_sha256   | `BTCUSDT`       | Binance USD-M futures. ⚠️ **Mainnet, real funds** in the hosted deployment (since 2026-07-27) |
| `okx`               | live   | perp        | hmac_sha256   | `BTC-USDT-SWAP` | OKX perpetual swap. Signs only where an OKX key is provisioned — the hosted deployment has none today, so there it signs nowhere |
| `asterdex`          | live   | perp        | eip712 (bsc)  | `BTC-USD`       | Asterdex on-chain perp (BSC) |
| `kucoin`            | live   | perp        | hmac_sha256   | `XBTUSDTM`      | KuCoin Futures (HMAC + encrypted passphrase); qty in contracts |
| `bybit`             | live   | perp        | hmac_sha256   | `BTCUSDT`       | Bybit V5 linear (`category=linear`) |
| `hyperliquid_testnet` | live | perp        | eip712 (hyperliquid) | `BTC`    | **The Hyperliquid path that actually signs.** Same enclave code as mainnet, testnet phantom-agent source |
| `hyperliquid_main`  | live    | perp    | eip712 (hyperliquid) | `BTC`    | Order and cancel only — the enclave has no withdrawal or transfer action for this venue. Mainnet carries an unconditional money floor (authority-signed policy + binding per-asset caps by integer asset index), not relaxable by a build flag. Account read is the public `clearinghouseState` |

The agent config block is identical for every venue — point `SIGNER_GATEWAY_URL` at your Signer and set `SIGNER_API_TOKEN`. Which venues a given token may trade is bound server-side to that token's policy; `list_venues` reports the full set the gateway can sign, not your per-token allow-list.

### `get_attestation`

Returns the Nitro attestation document for the currently-running enclave. The PCR0 measurement here is what AWS signed when it booted the enclave; you can verify it matches the published build by hashing the corresponding EIF and comparing.

```json
{
  "pcr0_sha384": "...sha384 hex...",
  "attestation_doc_b64": "...base64 COSE_Sign1, signed by AWS Nitro...",
  "registered_onchain": true,
  "timestamp_ms": 1785847208571
}
```

`pcr0_sha384` is a convenience copy; the evidence is `attestation_doc_b64` — the
AWS-signed COSE document containing all PCRs. Trust the document, not the field
printed beside it.

Read-only, works without a token.

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
- `venue` — one of `binance | okx | asterdex | kucoin | bybit | hyperliquid_testnet | hyperliquid_main`. ⚠️ v0 has structured order routes for **`binance | okx` only** — other venues return a clear error (they expose read-only account access); and check `list_venues` `status` first
- `symbol` — canonical (`BTC`, `BTCUSDT`, `BTC/USDT`) **or** venue-native (`BTC-USDT-SWAP`, `XBTUSDTM`, …). The client translates to the venue's native format and echoes it back.
- `side` — `buy` | `sell`
- `qty` — **always base-asset quantity** (e.g. 0.001 for 0.001 BTC). Not USD-notional, not venue contracts. Contract-denominated venues (okx: 1 contract = 0.01 BTC on `BTC-USDT-SWAP`) are converted automatically; sizes off the venue's contract grid are rejected, never silently rounded.
- `type` — `market` | `limit`
- `price` — required if `type=limit`, ignored if `type=market`
- `policy_id` — optional override; defaults to the policy bound to your token

The result includes a `translation` echo — check `translation.sent` to see the exact venue-native symbol + size that hit the exchange:

```json
{
  "requested": { "symbol": "BTC", "qty": 0.01, "unit": "base_asset" },
  "sent": { "symbol": "BTC-USDT-SWAP", "qty": "1", "unit": "contracts", "ctVal": "0.01" }
}
```

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

**Destructive.** Requires `SIGNER_API_TOKEN`. ⚠️ **Orders go where your token's
policy sends them — there is no implicit testnet routing.** On Binance the hosted
deployment signs **mainnet orders with real funds** (since 2026-07-27); OKX signs
only where an OKX key is provisioned (the hosted deployment has none today);
Hyperliquid signs on both `hyperliquid_testnet` and `hyperliquid_main`. Mainnet additionally
requires an authority-signed policy carrying binding per-asset caps — a blob without them is
refused at load, unconditionally.
An earlier revision of this section said "v0 routes Binance/OKX to testnet" —
that was wrong, see CHANGELOG 0.6.0.

### `place_hedge`

Places a 2-leg hedge with **atomic signing**: both legs are signed inside the
enclave all-or-nothing (a policy denial on either leg means **nothing** is even
sent), then the gateway fires both venue calls **server-side in parallel** — the
leg gap collapses to the venues' own latency spread and the signed auth headers
never transit through your client. ⚠️ Venue **execution is not atomic**: the
`partial` and `unknown` statuses below exist precisely because an exchange can
accept one leg and lose or reject the other.

Args:
- `legs` — exactly 2, each `{venue, symbol, side, qty, type}`. v1 constraints:
  `type: "market"` only (a resting limit leg would let "executed" hide an
  unfilled leg — use `place_order` for limits) and venues limited to
  `binance | okx`. Typical hedge: same symbol, opposite sides, equal
  base-asset qty on two venues.
- Symbols and `qty` use the same canonical/base-asset translation as
  `place_order`; per-leg `translations` are echoed back.

Read the result's `status` **before anything else**:
- `executed` — both legs live.
- `partial` — 🔴 **exactly one leg live: the position is NAKED.** Repair by
  closing the live leg or re-placing the `rejected` one. Never re-place a leg
  whose outcome is `unknown`.
- `unknown` — 🔴 a leg's receipt was lost (timeout / venue 5xx) — that order
  **may be live**. Do NOT retry `place_hedge`; reconcile first via
  `get_account` on both venues.
- `failed` — both legs definitively rejected, nothing live, safe to fix and retry.

**Destructive** (moves real positions on two venues at once). Requires
`SIGNER_API_TOKEN`. Gateways older than the `/hedge` endpoint return a clear
"use two place_order calls" error.

### `cancel_order`

Cancels an outstanding order by its venue order id. Idempotent — cancelling an already-filled or non-existent order returns `ok: false` with a venue reason instead of erroring.

Available for `binance | okx` in v0 — other venues have no structured cancel
route yet and return a clear error (same limitation as `place_order`).

Args:
- `venue` — `binance | okx`
- `order_id` — the venue id returned by `place_order`
- `symbol` — **required** (canonical `BTC` or venue-native; translated exactly like `place_order`) — both venues' REST cancel routes need it alongside `order_id`

Requires `SIGNER_API_TOKEN`.

---

## Verifying the attestation

A trustworthy Signer is one whose enclave measurement matches a build you can audit. The workflow:

1. Call `get_attestation` and copy the returned `pcr0_sha384` (or, stricter, read PCR0 out of the signed `attestation_doc_b64` itself).
2. Visit [usenami.io/signer/attestations](https://usenami.io/signer/attestations).
3. Cross-reference the PCR0 against the published build for the current production version.
4. Optionally rebuild the EIF from source and verify the measurement yourself — step-by-step instructions: [VERIFY-SIGNER-YOURSELF](https://github.com/namixai/signer/blob/main/docs/VERIFY-SIGNER-YOURSELF.md).

If the published PCR0 doesn't match what `get_attestation` returns, **don't trade**. Open an issue.

---

## What v0 deliberately does NOT do

v0 keeps the surface deliberately tight:

- No multi-tenant: one account per venue per token.
- No UPL editing UI: policies are set out-of-band on usenami.io/signer.
- No WebSocket / streaming tools — REST only.
- No cross-venue routing (`place_order` takes one venue; the only multi-venue tool is the fixed 2-leg `place_hedge`).
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

# run from source against the hosted demo enclave
SIGNER_GATEWAY_URL=https://signer-demo.usenami.io:8443 \
SIGNER_API_TOKEN=sk_test_... \
npm run dev
```

The transport is stdio; you'll need an MCP-aware client to actually exercise the tools. The Anthropic [`mcp-inspector`](https://github.com/modelcontextprotocol/inspector) is the fastest way to poke at it locally.

---

## License

MIT. See [LICENSE](LICENSE).
