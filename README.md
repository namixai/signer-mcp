# @usenami/signer-mcp

> Sign CEX orders from any MCP-aware AI agent — the signing secret never leaves the AWS Nitro Enclave.

`signer-mcp` is the public face of [Usenami Signer](https://usenami.io/signer). It gives Claude Desktop, Cursor, ElizaOS, and any other MCP-aware client a six-tool surface for trading real CEX/DEX perp accounts (Binance, OKX, Asterdex, KuCoin, Bybit, Hyperliquid) without the signing secret ever entering the agent's process — or yours.

Status: **v0 (alpha), invite-based pilot**. Venue manifest, attestation, account read, place/cancel order, and a two-leg hedge. ⚠️ **Assume orders are real.** Which venue and network your orders hit is decided by the policy bound to your token, and neither this page nor `list_venues` can tell you which — ask whoever issued the token. There is no implicit testnet safety net, so treat every order as mainnet money until you have confirmed otherwise. Read [`place_order`](#place_order) before sending anything.

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

3. **Restart Claude Desktop** and look for the 🔌 plug icon. You should see seven tools listed under `signer`: `list_venues`, `get_attestation`, `get_verified_price`, `get_account`, `place_order`, `place_hedge`, `cancel_order`. (The list is named rather than counted on purpose — a count in prose goes stale the moment a tool is added, and this one did: it said six until `get_verified_price` shipped.)
4. **Try the read-only tools first.** Ask Claude:
   > "List the venues available through Signer, then return the current attestation document."

   No funds at risk — these don't sign anything, and neither needs a token.

5. **Once you have a token and trust the attestation, you can place a first order — knowingly.**
   ⚠️ This signs a **real order on the venue your token's policy allows**, and you should
   assume that means **mainnet, real money** — 0.001 BTC is a real position, not a testnet
   exercise, unless the person who issued your token told you otherwise. Start with the
   smallest size your policy allows, and only then:
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

The agent now exposes the same seven tools (`list_venues`, `get_attestation`,
`get_verified_price`, `get_account`, `place_order`, `place_hedge`, `cancel_order`). Same
trust model: the signing key
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
| `X402_PRIVATE_KEY` | only for `get_verified_price` | — | Payer key for the x402 gateway: each price query costs one cent in USDC on Base. Without it the tool refuses `no_payer_key` and spends nothing — it never sends an unpaid request and never falls back to an unverified source. Use a wallet funded for this and nothing else; the ceiling per payment is capped in code. |

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
| `binance`           | live   | perp        | hmac_sha256   | `BTCUSDT`       | Binance USD-M futures. ⚠️ Assume **mainnet, real funds** — the network is set by your token's policy, not by this table |
| `okx`               | live   | perp        | hmac_sha256   | `BTC-USDT-SWAP` | OKX perpetual swap. Signs where an OKX key is provisioned; only the gateway you point at can say whether one is. Sizes are in **contracts** (1 `BTC-USDT-SWAP` = 0.01 BTC) |
| `asterdex`          | live   | perp        | eip712 (bsc)  | `BTC-USD`       | Asterdex on-chain perp (BSC) |
| `kucoin`            | live   | perp        | hmac_sha256   | `XBTUSDTM`      | KuCoin Futures (HMAC + encrypted passphrase); qty in contracts |
| `bybit`             | live   | perp        | hmac_sha256   | `BTCUSDT`       | Bybit V5 linear (`category=linear`) |
| `hyperliquid_testnet` | live | perp        | eip712 (hyperliquid) | `BTC`    | Same enclave code as mainnet, testnet phantom-agent source. Not reachable via `place_order`/`cancel_order` in v0 |
| `hyperliquid_main`  | live    | perp    | eip712 (hyperliquid) | `BTC`    | Order and cancel only — the enclave has no withdrawal or transfer action for this venue. Mainnet carries an unconditional money floor (authority-signed policy + binding per-asset caps by integer asset index), not relaxable by a build flag. Account read is the public `clearinghouseState` |

The agent config block is identical for every venue — point `SIGNER_GATEWAY_URL` at your Signer and set `SIGNER_API_TOKEN`. Which venues a given token may trade is bound server-side to that token's policy; `list_venues` reports the full set the gateway can sign, not your per-token allow-list.

### `get_attestation`

Fetches the Nitro attestation document **with a fresh nonce** and verifies it locally
before returning anything. PCR0/PCR1/PCR2 are read out of the signed bytes.

🔴 **Corrected in 0.7.1, and worth saying plainly.** Until 0.7.0 this tool sent no nonce
and verified nothing — it forwarded the gateway's JSON and described itself as proof that
"the code currently signing your orders matches the published source". Neither half held.
Without a nonce the document is bound to nothing, so a replay of an older attestation was
indistinguishable from a fresh one, and "currently" was unearned. And nothing was checked:
not the hardware signature, not the certificate chain, not the root. This is the only
surface a third-party agent consumes, which made it the worst place in the product to keep
a decorative verifier.

```json
{
  "verified": true,
  "checks": {
    "document_readable": true,
    "nonce_echoed": true,
    "root_pinned": true,
    "chain_verified": true,
    "signature_verified": true
  },
  "pcr0": "...sha384 hex, read from the SIGNED document...",
  "nonce_sent": "...16 random bytes, hex...",
  "nonce_in_document": "...the same value, or the check above is false...",
  "root_sha256": "641a0321...bb5b",
  "pinned_root_sha256": "641a0321...bb5b",
  "proves": ["..."],
  "do_not_trust_for": ["..."],
  "document": { "attestation_doc_b64": "...", "pcr0_sha384": "...", "timestamp_ms": 0 }
}
```

Every check can fail on its own, and `verified` is the AND of all five. When anything is
false the document is still returned — you may want to look at it — but `proves` is empty
and `do_not_trust_for` leads with the only honest reading: **a document that does not
verify is not weaker evidence, it is none.**

**What the tool cannot establish, stated in its own output rather than left to be
inferred:** that PCR0 corresponds to the published source (rebuild from the public clone
and compare, or ask the on-chain registry), and anything about a past signature — an
attestation speaks about the code that answered *this* request.

`root_pinned` is the load-bearing one. Whoever answers on `SIGNER_GATEWAY_URL` can mint
their own CA under AWS's own subject name, sign their own chain and a document carrying
any measurement they like, and echo the nonce; the other four checks then pass. The pinned
fingerprint is what they cannot forge. There is deliberately no environment variable to
relax it. To stop taking our word for that one constant, compare it once:

```bash
curl -sO https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip
unzip -p AWS_NitroEnclaves_Root-G1.zip > aws-nitro-root
openssl x509 -in aws-nitro-root -outform DER | shasum -a 256
```

⚠️ The sample above no longer shows `registered_onchain`. That field used to be in the
gateway's response and is gone — measured against the live endpoint on 12 September, with
a nonce the body carries `attestation_doc_b64`, `nonce`, `pcr0_sha384` and `timestamp_ms`,
and without one the same minus `nonce`. It would have been the operator's own
configuration reported back as if it were a fact about the chain, which is why nothing
here depends on it.

⚠️ **And the body's `nonce` echo is worth exactly nothing as a check.** The gateway writes
it, the same way it writes `pcr0_sha384`. `nonce_echoed` compares against the nonce inside
the **signed** document; a client that compared the body field instead would be asking the
operator whether the operator was honest.

Read-only, works without a token. Verification needs no network beyond the gateway call
and no dependencies — Node's own crypto does the chain and the ES384 signature.

### `get_verified_price`

Reads a Uniswap V3 token price from The Graph and returns it **only if four checks pass**.
Runs entirely outside the enclave — this is a reading, not a signature, and the README says
so where a reader might otherwise assume the enclave vouched for the number.

```
get_verified_price(token_address="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
```

| the check | what it stops |
|---|---|
| the indexer signed the exact bytes that arrived | a re-serialised body hashes differently, so a "verified" answer over modified JSON |
| that signer resolves on chain to an indexer with stake | a signature from nobody in particular |
| the reading is a **usable** price | a verified signature over a GraphQL error, or over a zero, is not a price |
| the price's own age, measured apart from the subgraph head's | a fresh head carrying a year-old price — prices are written in event handlers, so a dead market keeps a dead one under green indexing |

On refusal **no price is returned**, and the answer names both the check that stopped it
(`stage`) and that check's own reason (`cause`). `price_absent_or_zero`, `graphql_errors`
and `price_stale` are three different problems with three different fixes, which is why
they are three different words.

**Name the token by address when you can.** A ticker is not a key in this subgraph: asking
it for `WETH` returns several tokens with that name, all of them real. So every match is
checked and returned rather than the first one being guessed at. With neither an address
nor a ticker, the tool returns the most recently priced tokens, filtered to those that
actually carry a price.

**It costs money and says so up front:** one cent in USDC on Base per query, paid through
the x402 gateway, which needs `X402_PRIVATE_KEY`. Without that key the tool refuses
`no_payer_key` and spends nothing — it does not send an unpaid request, and it does not
quietly fall back to an unverified source.

### Where the signed headers go

🔴 **On `get_account`, `place_order` and `cancel_order` the signed auth headers pass
through your client.** The gateway returns `{method, url, headers}`; this package then
sends that request to that URL itself. Those headers are what authenticates you to the
exchange: the API **key** travels in them (`X-MBX-APIKEY` on Binance, `OK-ACCESS-KEY` on
OKX) and on OKX the **passphrase** travels with it. Only the signing **secret** stays
inside the enclave — that is the claim we make, and it is narrower than "your credentials
never leave".

What follows from that, stated plainly rather than left to inference:

* **Anything that can read your process memory, your logs, or your outbound traffic at
  that moment can read those headers.** They are short-lived and scoped to one request,
  which limits the damage; it does not remove it.
* **There is no host allow-list in this client.** It sends to whatever URL the gateway
  named. A gateway that has been compromised or impersonated could name its own host and
  collect the key. Pin the gateway you trust (`SIGNER_GATEWAY_URL`) and verify its
  attestation — `get_attestation` exists for this, and the enclave measurement is what
  tells you which code answered.

`place_hedge` is the exception and the model for the rest: both legs are signed and both
venue calls are fired **server-side**, so nothing authenticating ever reaches your
process. Moving the other three onto that shape is the fix; until it lands, this section
is the honest description of what happens today.

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

Read-only. Requires `SIGNER_API_TOKEN`. The signed headers for this call pass through
your client — see [Where the signed headers go](#where-the-signed-headers-go).

### `place_order`

Place a single market or limit order. The enclave signs the payload after checking policy caps,
and your client then sends the signed request to the venue — see
[Where the signed headers go](#where-the-signed-headers-go).

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
whether a given gateway signs against mainnet or testnet, and with what caps, is a property
of that deployment and of your token's policy — this page cannot tell you, and neither can
`list_venues`. On Hyperliquid the enclave signs both testnet and mainnet, and mainnet
additionally requires an authority-signed policy carrying binding per-asset caps — a blob
without them is refused at load, unconditionally. Note that **neither** Hyperliquid venue is
reachable through `place_order` / `cancel_order` in v0: those carry structured routes for
`binance` and `okx` only.
An earlier revision of this section said "v0 routes Binance/OKX to testnet" —
that was wrong, see CHANGELOG 0.6.0.

### `place_hedge`

Places a 2-leg hedge with **atomic signing**: both legs are signed inside the
enclave all-or-nothing (a policy denial on either leg means **nothing** is even
sent), then the gateway fires both venue calls **server-side in parallel** — the
leg gap collapses to the venues' own latency spread and the signed auth headers
never transit through your client. 🔴 That last part is true **of this tool only**:
`get_account`, `place_order` and `cancel_order` do transit them, for the reasons in
[Where the signed headers go](#where-the-signed-headers-go).
Do not read this sentence as a property of the package. ⚠️ Venue **execution is not atomic**: the
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
route yet and return a clear error (same limitation as `place_order`). The signed headers
for this call pass through your client — see
[Where the signed headers go](#where-the-signed-headers-go).

Args:
- `venue` — `binance | okx`
- `order_id` — the venue id returned by `place_order`
- `symbol` — **required** (canonical `BTC` or venue-native; translated exactly like `place_order`) — both venues' REST cancel routes need it alongside `order_id`

Requires `SIGNER_API_TOKEN`.

---

## Verifying the attestation

A trustworthy Signer is one whose enclave measurement matches a build you can audit. The workflow:

1. Call `get_attestation`. Check `verified` is true and read `pcr0` — the tool has already taken it out of the signed document, checked the nonce it just sent, walked the certificate chain and compared the root against the pinned fingerprint. If `verified` is false, stop here: `checks` names which one failed.
2. **Ask the chain, which is not ours to edit.** Call `isPCR0Active(pcr0)` on
   `0x38b42eED740b0fDeb211bBDf773F2238cAEec240` (Base). It returns two values and **both
   decide**: whether that measurement is active, and the address of the owner who
   registered it. Read what it answers rather than looking for a particular answer —
   the registry keeps one active measurement per owner, so which of our lanes holds it
   moves over time.
3. **Find the same measurement in the tag table** of
   [`docs/REPRODUCIBLE-BUILD.md`](https://github.com/namixai/signer/blob/main/docs/REPRODUCIBLE-BUILD.md).
   Tags there are named `pcr0-<first eight hex of the measurement>` and each row names the
   commit it was cut from and the lane it was cut for.
4. **Rebuild the EIF from that commit** and compare the number you get against the one you
   started from: [VERIFY-SIGNER-YOURSELF](https://github.com/namixai/signer/blob/main/docs/VERIFY-SIGNER-YOURSELF.md).
   This is the step that needs nothing from us at all.

**Stop and do not trade** if any of these is true — and the first one is easy to miss:

- the registry names an **owner you do not recognise**. A measurement can be active and
  registered by somebody else entirely; "active" alone is not a pass, and an owner check
  that only happens in your head is not a check.
- the registry says that measurement is **not active**;
- the **tag table does not name** your measurement;
- your **own rebuild** produces a different number.

Open an issue in any of those cases.

> 🔴 **Why this no longer sends you to our page first.** The page at
> [usenami.io/signer/attestations](https://usenami.io/signer/attestations) reads its live
> value from the **public demo gateway** — checked: the page's own markup calls
> `signer-demo.usenami.io:8443/attestation`. That is not necessarily the box your MCP
> server talks to. When two of our boxes run the same measurement, comparing one against
> the other looks like verification and proves nothing: you would be checking a gateway
> against a gateway, both of them ours.
>
> That is not hypothetical today. The tag table linked above lists three measurements, two
> of them retired, and records production and the public demo as sharing one measurement
> since 2026-09-11 — so right now the comparison happens to agree, which is exactly when a
> hollow check is hardest to notice.
>
> The page is still worth reading: it carries the registry address and the rebuild recipe.
> But the three things that can contradict us — the chain, the tag table, and your own
> build — are the ones that decide, and not one of them is a box we operate.

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
