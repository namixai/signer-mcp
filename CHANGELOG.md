## 0.6.1 — 2026-08-31

Релиз без изменений кода: две правки уже лежали в main непубликованными, и
одна из них — снятая ложная гарантия безопасности. Публичный пакет читают как
правду, поэтому непубликованная правка такого рода хуже, чем её отсутствие.

- 🔴 **`hyperliquid_main` перестал числиться `denied`.** Этот статус ввели в
  0.4.0 (06.08), описывая безусловный отказ энклава, который **ROT-1 снял днём
  раньше**. То есть манифест уехал уже устаревшим, и 16.08 боевой ордер на
  Hyperliquid прошёл, пока пакет продолжал сообщать каждому агенту, что венью
  отвергается до загрузки ключевого материала. Клейм безопасности, переживший
  свой механизм, хуже отсутствующего: читатель под него планирует.
  Починено в `#13`, опубликовано только сейчас.
- Планка для `denied` поднята и записана в типе: не «сегодня отвергает», а
  безусловный отказ на уровне кода, который не снимается ни политикой, ни
  флагом, ни credential'ами. Сейчас его не несёт ничто.
- Оговорено, что значит `live`: «энклав подпишет, если ключ провижионен».
  Это НЕ утверждение, что ключ есть в вашем деплое — на такой вопрос отвечает
  шлюз, а не константа в пакете.
- Клейм о ключе сужен до того, что энклав действительно гарантирует (`#14`).

## 0.6.0 — 2026-08-10

Публичная поверхность приведена к фактам — по двум независимым прогонам пути
клиента с нуля 2026-08-10 (внутренний client-zero и внешний аудит «чужого»).

- 🔴 README обещал «v0 routes Binance/OKX to testnet». Это неправда с
  2026-07-27: Binance в хостед-деплое подписывает mainnet-ордера реальными
  деньгами. Манифест венью починили ещё в 0.5.0 — README продолжал звать
  реальный ордер «тестовым». Переписаны статус-строка, шаг 5 квик-старта и
  раздел place_order; таблица венью несёт предупреждение mainnet.
- 🔴 Дефолтный SIGNER_GATEWAY_URL сменён: https://signer.usenami.io →
  https://signer-demo.usenami.io:8443 (хостед-энклав с аттестацией). Старый
  хост 301-редиректит каждый путь на маркетинговый лендинг, поэтому все
  сетевые инструменты падали из коробки с «Unexpected token '<'». HTML-ответ
  гейтвея теперь распознаётся и называется своим именем: «the gateway
  returned HTML, not JSON — check SIGNER_GATEWAY_URL».
- Доступ назван инвайтным прямо в README (self-serve выдачи токенов нет);
  из ошибки об отсутствии токена убрана ссылка «Issue tokens at…»,
  которая вела на страницу без выдачи.
- place_hedge задокументирован (destructive, ровно 2 market-ноги на
  binance/okx, состояния executed / partial / unknown / failed и что с ними
  делать); «five tools» → «six» во всех трёх местах; server.json приведён к
  актуальной версии и полному списку из шести инструментов; у cancel_order
  задокументирован обязательный symbol для binance/okx.
- Таблица венью: 7 записей — добавлен hyperliquid_testnet (единственный
  подписывающий путь Hyperliquid), hyperliquid_main помечен denied
  (запрет внутри энклава); поля status/network задокументированы; сэмпл
  count исправлен 6 → 7. Сэмпл get_attestation приведён к фактической форме:
  pcr0_sha384 / attestation_doc_b64 / registered_onchain / timestamp_ms.
- «Instructions on the same page» про пересборку EIF заменены живой ссылкой
  на namixai/signer/docs/VERIFY-SIGNER-YOURSELF.md; упоминание
  staging.signer.usenami.io (не резолвится) убрано из раздела Development.
- Служебные самокоррекции перенесены из notes манифеста сюда, где им место:
  (1) binance: формулировка «limited to testnet» была ложной с 2026-07-27 —
  mainnet-подписи идут в проде средствами самого оператора, внешние
  design-партнёры остаются на testnet-политиках; (2) okx: прежняя
  формулировка подразумевала, что testnet работает, — на деле в
  хостед-деплое OKX-ключ не провижнён и OKX там не подписывает нигде.
- ElizaOS-раздел README больше не отрицает нативный плагин: указывает на
  @usenami/plugin-signer (опубликован, 0.4.x), generic-мост
  @elizaos/plugin-mcp остаётся альтернативой.

## 0.5.1 — 2026-08-09

Версия берётся из манифеста, а не дублируется константой в коде.

0.5.0 печатала при старте `[signer-mcp v0.3.0]`: номер в `package.json` подняли,
`PACKAGE_VERSION` в `src/lib.ts` забыли. Содержимое пакета при этом было верным —
релизная проверка искала строки про площадки и не спрашивала, совпадает ли версия
с манифестом. Клиент, увидевший чужой номер, не может отличить «npx подсунул
старую копию из кэша» от «пакет врёт о себе» — а ровно эти два случая и надо было
различить при разборе.

Тот же номер уходит и в заголовок `User-Agent`, то есть на шлюзе в логах стояла
неверная версия клиента.

# Changelog

All notable changes to `@usenami/signer-mcp` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

## [Unreleased]

## [0.5.0] — 2026-08-06 (venue notes brought to the facts)

### Fixed
- **`binance` claimed "v0 limited to testnet until pilot graduates". That has been
  false since 2026-07-27**, when the signer began signing real orders with real
  money on Binance mainnet. Anyone reading the manifest to decide whether mainnet
  was usable got the wrong answer for over a week.

  The replacement states *whose* mainnet, because a blanket "mainnet-live" reads
  as "clients are trading live" and that is not true: it is **founder dogfood on
  our own funds**, and external design partners remain on **testnet**. The note
  also says USD-M futures only — spot order signing is not implemented, and
  "spot routes merged" is not the same claim.
- **`okx` said "v0 limited to testnet", which implies testnet works.** No OKX key
  is provisioned in the reference deployment, so it signs nowhere today — mainnet
  or testnet. Stated plainly instead.

### Changed
- `VenueEntry.status` is documented as a statement about the **signer's rules**,
  not about any deployment's provisioning, and deliberately gains no
  `unavailable` state. "No key here" differs per operator: encoding it would make
  the manifest wrong for everyone but one deployment and would drift the moment a
  key is added — the exact failure this field exists to prevent. The `okx` note
  is reworded the same way: what the enclave does, plus what Usenami's hosted
  deployment happens to have, clearly separated.

### Notes
- Five entries remain after `binance` and `okx`, and they split in two:
  `asterdex`, `kucoin` and `bybit` carry **no** deployment-state claims — auth
  scheme and symbol format only, which is what a venue manifest should assert.
  The two `hyperliquid_*` entries **do** carry status, deliberately: that was the
  point of the previous release, and `hyperliquid_main` being `denied` is a
  property of the enclave, not of any one deployment.
  Every venue listed has a real handler in the enclave — checked against
  `venue_for_action`, not assumed.

## [0.4.0] — 2026-08-06 (Hyperliquid mainnet status corrected)

### Fixed
- **`hyperliquid_main` was listed as an ordinary, usable venue. It is not.** The
  enclave refuses `sign_hyperliquid_main_order` / `_cancel` before it loads or
  decrypts any key material, and has done so since 2026-06-26. Anyone building
  against the old manifest produced a call that could only come back as a policy
  denial. This was a functional bug, not a documentation nit.

### Added
- **`status: "live" | "denied"` on every venue entry.** The correction is data,
  not prose: a caller that reads a machine-readable manifest and ignores free
  text is behaving reasonably, and would still have tried.
- **`hyperliquid_testnet`**, status `live`, listed ahead of the denied mainnet
  entry. Saying only "Hyperliquid is denied" would be its own inaccuracy in the
  other direction — testnet signs through the same EIP-712 code path, differing
  only in the phantom-agent source byte.

### Changed
- `denied` means the signature is refused **inside the enclave**, not that
  configuration is missing. Supplying credentials does not change it. The venue
  notes now say so explicitly.
- `list_signer_venues` returns the manifest verbatim, so the new field and the
  testnet entry appear without further change.

### Upgrading
`VenueEntry` gained a required `status` field, so TypeScript consumers that
construct or implement the interface must add it. Consumers that only READ the
manifest are unaffected apart from seeing one more venue and the new field.

### Added
- (placeholder)

## [0.3.0] - 2026-06-11

### Fixed
- **CRITICAL: OKX orders were silently ~100× undersized (contracts vs base
  asset).** OKX perp swap `sz` is denominated in CONTRACTS (`BTC-USDT-SWAP`:
  1 contract = 0.01 BTC), but the client passed `qty` through raw. An agent
  sending `qty=0.01` (meaning 0.01 BTC) actually traded 0.01 contracts =
  0.0001 BTC — a "balanced hedge" against a Binance leg was really a naked
  position. `qty` is now ALWAYS base asset at the tool boundary and is
  converted to venue-native contracts via a pinned per-instrument `ctVal`
  table (BTC/ETH/SOL USDT swaps, verified against `GET
  /api/v5/public/instruments` 2026-06-11). Sizes that don't fit the contract
  grid, fall below the venue minimum, or reference an instrument not in the
  pinned table are REJECTED with the nearest valid sizes spelled out — never
  silently rounded, never passed through raw.

### Added
- **Venue normalization layer (canonical symbol).** `place_order` /
  `cancel_order` now accept the canonical base (`BTC`), canonical pairs
  (`BTCUSDT`, `BTC/USDT`), or the venue-native symbol, and translate to the
  venue's native format (`BTC-USDT-SWAP` on okx, `XBTUSDTM` on kucoin, …).
  Unknown/ambiguous symbols are rejected with the expected native form.
- **Translation echo.** `place_order` results now include a `translation`
  object showing `requested` (user units) vs `sent` (venue-native symbol,
  qty, unit, ctVal) so the agent always sees exactly what hit the exchange —
  kills the silent-unit-mismatch class.

### Changed
- **BREAKING (okx semantics):** if you previously passed OKX `qty` in
  contracts, the same number now means base asset and converts to ~100× more
  contracts — such orders will be rejected by the server-side policy cap
  until the cap is re-papered in contracts. Binance is unchanged (already
  base-asset-denominated).

## [0.2.3] - 2026-06-10

### Fixed
- **`get_account okx` returned $0 for everyone (composite legs never executed):**
  the gateway's composite `/account/okx` response nests `balance`/`positions`
  legs WITHOUT a `venue` field (it lives once on the parent), but the composite
  walker only executed legs that passed the strict `isSignedRequest` check
  (venue required). The legs were silently treated as pass-through fields and
  never fetched; the parser then received raw unexecuted `{method,url,headers}`
  objects and normalized them to a fabricated `$0 / 1970` balance. The walker
  now recognizes inner legs by shape (`{method,url,headers}`) and injects the
  parent bundle's `venue` for error labels. Top-level requests keep the strict
  venue check. A failed (blocked/4xx) leg surfaces an error per the 0.2.2 #136
  guard — it is never rendered as $0. The unit-test fixture that codified the
  wrong composite shape (inner `venue` present) now mirrors the real gateway.

## [0.2.2] - 2026-06-10

### Fixed
- **place_order / cancel_order contract mismatch (highest):** the client sent the
  flat MCP tool input as the gateway body, but the gateway expects
  `{ key_id, order: { symbol, side, qty, ord_type, price?, reduce_only } }` (and
  `{ key_id, cancel: { symbol, order_id } }` for cancel) → every order failed with
  HTTP 422 "missing field `key_id`". Client now builds the correct per-venue body:
  `key_id` = venue id (venue-keyed blobs), `qty`/`price` as strings, tool `type` →
  `ord_type`, `price` omitted for market. binance + okx only (the venues with
  structured order routes); other venues return a clear error instead of a 404.
- **silent $0 on failed exchange execute (bug #136):** when a signed request to a
  venue came back non-JSON (Cloudflare/geo/WAF block page), the client returned a
  fabricated `$0 / updated_at 1970` balance instead of an error. `submitSignedRequest`
  now throws on non-JSON bodies, and the OKX/Binance parsers throw on venue error
  responses (OKX `code != "0"`, Binance negative `code`). A blocked OKX leg now
  surfaces a clear error to the model, never a fake zero balance.

## [0.2.1] - 2026-06-10

### Fixed
- Send a browser-like `User-Agent` when the client executes a signed request
  against an exchange. OKX's Cloudflare edge rejects non-browser User-Agents
  with HTTP 403 "error code: 1010" before the request reaches the API; the
  gateway is sign-only, so the client controls this UA. Binance is unaffected.
  Signed venue headers still take precedence over the default UA.

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
