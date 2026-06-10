/**
 * Core handlers and helpers for @usenami/signer-mcp.
 *
 * Extracted from index.ts so unit tests can exercise the gateway-call paths
 * without booting a real MCP transport. index.ts wires these into MCP tools.
 */

export const PACKAGE_VERSION = "0.2.2";
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

// Venues that have a structured order/cancel route on the gateway
// (`/sign/<venue>-order`, `/sign/<venue>-cancel`). Only binance + okx in v0;
// other venues currently expose read-only account access. place_order /
// cancel_order on anything else returns a clear error instead of a 404.
export const STRUCTURED_ORDER_VENUES = new Set(["binance", "okx"]);

// Some exchange edges (notably OKX, behind Cloudflare) reject requests whose
// User-Agent looks non-browser ("Python-urllib/*", some default agents) with
// HTTP 403 "error code: 1010" — BEFORE the request reaches the exchange API.
// The signer gateway is sign-only; the *client* executes the signed request,
// so the UA on that fetch is ours to set. A realistic browser UA avoids the
// edge block. Binance is unaffected; this is harmless there.
export const EXCHANGE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── Venue manifest (v0 static) ──
export interface VenueEntry {
  venue: string;
  asset_class: string;
  auth_scheme: "hmac_sha256" | "eip712" | "ed25519";
  network?: string;
  notes?: string;
}

export const STATIC_VENUES: VenueEntry[] = [
  {
    venue: "binance",
    asset_class: "perp",
    auth_scheme: "hmac_sha256",
    notes:
      "Binance USD-M futures via REST. v0 limited to testnet until pilot " +
      "graduates. Symbol format: BTCUSDT (no slash).",
  },
  {
    venue: "okx",
    asset_class: "perp",
    auth_scheme: "hmac_sha256",
    notes:
      "OKX perpetual swap via REST. v0 limited to testnet. Symbol format: " +
      "BTC-USDT-SWAP.",
  },
  {
    venue: "asterdex",
    asset_class: "perp",
    auth_scheme: "eip712",
    network: "bsc",
    notes:
      "Asterdex on-chain perp. Uses Asterdex platform-controlled API wallet " +
      "(narrow per-asset caps enforced by Signer policy).",
  },
  {
    venue: "kucoin",
    asset_class: "perp",
    auth_scheme: "hmac_sha256",
    notes:
      "KuCoin Futures perp via REST. HMAC-SHA256 + KuCoin v2 encrypted " +
      "passphrase, all signed inside the enclave. Symbol format: XBTUSDTM " +
      "(KuCoin Futures contract code; qty is in contracts).",
  },
  {
    venue: "bybit",
    asset_class: "perp",
    auth_scheme: "hmac_sha256",
    notes:
      "Bybit V5 linear perp via REST (category=linear). Symbol format: " +
      "BTCUSDT (no slash).",
  },
  {
    venue: "hyperliquid_main",
    asset_class: "perp",
    auth_scheme: "eip712",
    network: "hyperliquid",
    notes:
      "Hyperliquid L1 perp. EIP-712 action signing (orders POST /exchange). " +
      "Symbol format: bare coin name, e.g. BTC. Account state is a public " +
      "read (POST /info clearinghouseState).",
  },
];

// ── Gateway HTTP ──
export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly endpoint: string,
  ) {
    super(`gateway ${endpoint} failed (${status}): ${body.slice(0, 240)}`);
    this.name = "GatewayError";
  }
}

export interface GatewayConfig {
  gatewayUrl: string;
  apiToken?: string;
  fetchTimeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface GatewayCallOpts {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  authRequired?: boolean;
}

/**
 * Single chokepoint for all gateway HTTP. Tests inject a `fetchImpl` and
 * assert against the dispatched request.
 *
 * Edge cases handled:
 *  - Missing token when authRequired → thrown with actionable message.
 *  - Empty 200 OK body → returned as undefined (rare but possible on some
 *    venues' cancel-already-filled paths).
 *  - Non-2xx → GatewayError carries status + body for the agent to inspect.
 *  - Timeout → AbortController + clearTimeout via try/finally.
 */
export async function callGateway<T>(
  path: string,
  opts: GatewayCallOpts,
  cfg: GatewayConfig,
): Promise<T> {
  const method = opts.method ?? "GET";
  const hasToken = Boolean(cfg.apiToken && cfg.apiToken.length > 0);
  if (opts.authRequired && !hasToken) {
    throw new Error(
      `SIGNER_API_TOKEN is required to call ${path}. Set it in your MCP ` +
        `client config — see README. (Issue tokens at https://usenami.io/signer.)`,
    );
  }
  const url = `${cfg.gatewayUrl.replace(/\/+$/, "")}${path}`;
  const timeoutMs = cfg.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const fetchFn = cfg.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `@usenami/signer-mcp@${PACKAGE_VERSION}`,
    };
    if (hasToken) headers.Authorization = `Bearer ${cfg.apiToken}`;
    let serialized: string | undefined;
    if (opts.body !== undefined) {
      serialized = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }
    const res = await fetchFn(url, {
      method,
      headers,
      body: serialized,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new GatewayError(res.status, text, path);
    return text.length === 0 ? (undefined as unknown as T) : JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// ── Tool handler payloads ──
// Note: index signature `[x: string]: unknown` required for MCP SDK compatibility
// (its CallToolResult schema expects open object shape).
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
  [x: string]: unknown;
}

export function toolJson<T>(value: T): ToolResult {
  // Guard: JSON.stringify(undefined) returns undefined (not a string), which
  // breaks downstream JSON.parse. Coerce undefined → null so empty 200-OK
  // gateway responses still produce a valid text body.
  const safe = value === undefined ? null : value;
  return {
    content: [{ type: "text", text: JSON.stringify(safe, null, 2) }],
  };
}

export function toolError(message: string, hint?: string): ToolResult {
  const payload = JSON.stringify(
    hint === undefined ? { error: message } : { error: message, hint },
    null,
    2,
  );
  return { content: [{ type: "text", text: payload }], isError: true };
}

// ── Order shape ──
export interface PlaceOrderInput {
  venue: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  type: "market" | "limit";
  price?: number;
  policy_id?: string;
}

export interface CancelOrderInput {
  venue: string;
  order_id: string;
  /**
   * Required for binance + okx (their REST APIs need symbol on the cancel
   * route). Optional for venues that derive it from order_id alone.
   */
  symbol?: string;
}

// ── Signed-request bundle (Option-A architecture) ──
// Signer's /account, /sign/order, /sign/cancel return either a single signed
// request OR a composite of named requests (OKX /account = balance+positions).
// signer-mcp executes the fetch(es) and returns the venue's raw response(s).
export interface SignedRequest {
  venue: string;
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function isSignedRequest(x: unknown): x is SignedRequest {
  // Hardened: reject primitives (truthy strings/bools still match !!obj),
  // reject null headers (`typeof null === "object"`), require string venue.
  if (x === null || typeof x !== "object") return false;
  const obj = x as Record<string, unknown>;
  return (
    typeof obj.venue === "string" &&
    typeof obj.method === "string" &&
    typeof obj.url === "string" &&
    obj.headers !== null &&
    typeof obj.headers === "object"
  );
}

/**
 * Submit a single signed request to a venue and return parsed JSON (or text
 * if the response isn't JSON). Errors include the venue endpoint + status so
 * the agent can reason about which side failed.
 */
export async function submitSignedRequest(
  req: SignedRequest,
  fetchImpl?: typeof fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const fetchFn = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(req.url, {
      method: req.method,
      // Browser-like UA first so exchange edges (OKX/Cloudflare) don't 1010 us;
      // spread signed headers AFTER so a venue-supplied header always wins.
      headers: { "User-Agent": EXCHANGE_USER_AGENT, ...req.headers },
      body: req.body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `venue ${req.venue} ${req.method} ${req.url.split("?")[0]} failed ` +
          `(${res.status}): ${text.slice(0, 240)}`,
      );
    }
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      // Bug #136: a non-JSON body from a JSON exchange API is almost always a
      // block/error page (Cloudflare challenge, geo-block, WAF) — NOT a valid
      // response. Surface it so callers never fabricate a $0 balance from junk.
      // (All venues we execute against today return JSON; revisit if that changes.)
      throw new Error(
        `venue ${req.venue} ${req.method} ${req.url.split("?")[0]} returned a non-JSON ` +
          `response (HTTP ${res.status}) — likely blocked at the exchange edge ` +
          `(geo/UA/WAF), not an empty account. Body: ${text.slice(0, 200)}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Submit a "bundle" — either a single SignedRequest or a map of named
 * SignedRequests (`{balance: ..., positions: ...}`). Parallel for composite,
 * returns the same shape with raw venue responses in place of each request.
 */
export async function submitSignedBundle(
  bundle: unknown,
  fetchImpl?: typeof fetch,
  timeoutMs?: number,
): Promise<unknown> {
  if (isSignedRequest(bundle)) {
    return submitSignedRequest(bundle, fetchImpl, timeoutMs);
  }
  // Composite — walk own keys, submit each SignedRequest in parallel.
  if (bundle === null || typeof bundle !== "object") {
    throw new Error(
      "Unexpected /account response shape: not a SignedRequest and not a " +
        "composite object. Gateway must return {method,url,headers} or " +
        "{key: {method,url,headers}, ...}.",
    );
  }
  const obj = bundle as Record<string, unknown>;
  const entries = Object.entries(obj);
  const requests = entries.filter(([, v]) => isSignedRequest(v));
  if (requests.length === 0) {
    // No signed requests at all — pass through (e.g. asterdex indexer
    // payload may be returned directly by the gateway, not as a signed req).
    return obj;
  }
  const results = await Promise.all(
    requests.map(async ([key, req]) => {
      const resp = await submitSignedRequest(req as SignedRequest, fetchImpl, timeoutMs);
      return [key, resp] as const;
    }),
  );
  const out: Record<string, unknown> = {};
  // Preserve any non-request fields (e.g. venue label).
  for (const [k, v] of entries) {
    if (!isSignedRequest(v)) out[k] = v;
  }
  for (const [k, v] of results) out[k] = v;
  return out;
}

// ── Tool handlers (pure logic, no MCP coupling) ──

export async function handleListVenues(): Promise<ToolResult> {
  return toolJson({ venues: STATIC_VENUES, count: STATIC_VENUES.length });
}

export async function handleGetAttestation(cfg: GatewayConfig): Promise<ToolResult> {
  try {
    const data = await callGateway<unknown>("/attestation", {}, cfg);
    return toolJson(data);
  } catch (err) {
    const e = err as Error;
    return toolError(
      e.message,
      "If the gateway is unreachable, list_venues still works (static " +
        "manifest, no network). Verify SIGNER_GATEWAY_URL.",
    );
  }
}

/**
 * Option-A flow for /account:
 *   1. POST gateway /account/<venue> → returns SignedRequest bundle
 *   2. submitSignedBundle → fetch venue with signed headers
 *   3. dispatch raw response to venue-specific parser
 *   4. return NormalizedAccount
 *
 * If the gateway response is NOT a SignedRequest (e.g. asterdex indexer
 * returns parsed data directly), we feed the raw payload to the parser
 * unchanged — parser is tolerant of both shapes.
 */
export async function handleGetAccount(
  cfg: GatewayConfig,
  args: { venue: string },
  getParser: (venue: string) => AccountParser | undefined,
): Promise<ToolResult> {
  const parser = getParser(args.venue);
  if (parser === undefined) {
    return toolError(
      `No account parser registered for venue '${args.venue}'.`,
      "Call list_venues to see supported venues.",
    );
  }
  try {
    const signed = await callGateway<unknown>(
      `/account/${encodeURIComponent(args.venue)}`,
      { authRequired: true },
      cfg,
    );
    const rawVenueResponse = await submitSignedBundle(signed, cfg.fetchImpl, cfg.fetchTimeoutMs);
    const normalized = parser(rawVenueResponse);
    return toolJson(normalized);
  } catch (err) {
    return toolError((err as Error).message);
  }
}

/**
 * Option-A flow for /sign/order:
 *   1. POST gateway /sign/order with intent body → returns SignedRequest
 *   2. submitSignedRequest → fetch venue, return raw venue receipt
 *   3. agent sees venue's native response (order_id format etc)
 *
 * No parser layer here — order receipts are per-venue and we don't normalize
 * them in v0. Agent inspects raw response to decide next action.
 */
export async function handlePlaceOrder(
  cfg: GatewayConfig,
  args: PlaceOrderInput,
): Promise<ToolResult> {
  if (args.type === "limit" && args.price === undefined) {
    return toolError(
      "price is required when type=limit",
      "For market orders, omit price and set type=market.",
    );
  }
  // type=market with price set is NOT rejected — some venues silently ignore,
  // others use as limit-on-fail. We pass through so the venue decides.
  const venue = args.venue.toLowerCase();
  if (!STRUCTURED_ORDER_VENUES.has(venue)) {
    return toolError(
      `place_order is only available for ${[...STRUCTURED_ORDER_VENUES].join(", ")} ` +
        `in this signer (v0). "${args.venue}" has no structured order route yet.`,
    );
  }
  try {
    // Gateway contract (proto.rs SignBinanceOrderRequest / SignOkxOrderRequest):
    //   { key_id, order: { symbol, side, qty, ord_type, price?, reduce_only } }
    // - key_id selects the venue-keyed blob (binance.enc / okx.enc). This is the
    //   SINGLE mapping point that becomes customer-scoped in multi-tenant (#132).
    // - qty/price are STRINGS in OrderParams; tool input `type` → gateway `ord_type`;
    //   `price` is omitted for market orders (gateway field is optional).
    const body = {
      key_id: venue,
      order: {
        symbol: args.symbol,
        side: args.side,
        qty: String(args.qty),
        ord_type: args.type,
        ...(args.price !== undefined ? { price: String(args.price) } : {}),
        reduce_only: false,
      },
    };
    const signed = await callGateway<unknown>(
      `/sign/${venue}-order`,
      { method: "POST", body, authRequired: true },
      cfg,
    );
    const venueResponse = await submitSignedBundle(signed, cfg.fetchImpl, cfg.fetchTimeoutMs);
    return toolJson({ venue: args.venue, response: venueResponse });
  } catch (err) {
    return toolError((err as Error).message);
  }
}

/**
 * Option-A flow for /sign/cancel — same as place_order.
 *
 * Note: Binance + OKX cancel routes require `symbol` on top of `order_id`.
 * The MCP tool exposes optional `symbol` to support these (and ignores it
 * for venues that don't need it).
 */
export async function handleCancelOrder(
  cfg: GatewayConfig,
  args: CancelOrderInput,
): Promise<ToolResult> {
  // Binance + OKX cancel REST routes require `symbol` alongside `order_id`.
  // Reject here with a clear message BEFORE the gateway round-trip, instead of
  // forwarding a symbolless request that the gateway rejects with an opaque
  // `bad_request` (signer #83 follow-up).
  const venue = args.venue.toLowerCase();
  if (!STRUCTURED_ORDER_VENUES.has(venue)) {
    return toolError(
      `cancel_order is only available for ${[...STRUCTURED_ORDER_VENUES].join(", ")} ` +
        `in this signer (v0). "${args.venue}" has no structured cancel route yet.`,
    );
  }
  if (!args.symbol) {
    return toolError(
      `cancel_order on "${args.venue}" requires "symbol" — its cancel REST route ` +
        `needs the venue-native symbol (e.g. BTCUSDT) alongside order_id.`,
    );
  }
  try {
    // Gateway contract (proto.rs SignBinanceCancelRequest / SignOkxCancelRequest):
    //   { key_id, cancel: { symbol, order_id } }  — same key_id mapping as place_order.
    const body = {
      key_id: venue,
      cancel: { symbol: args.symbol, order_id: args.order_id },
    };
    const signed = await callGateway<unknown>(
      `/sign/${venue}-cancel`,
      { method: "POST", body, authRequired: true },
      cfg,
    );
    const venueResponse = await submitSignedBundle(signed, cfg.fetchImpl, cfg.fetchTimeoutMs);
    return toolJson({ venue: args.venue, response: venueResponse });
  } catch (err) {
    return toolError((err as Error).message);
  }
}

// Re-export parser type so callers can pass getAccountParser without importing
// the parsers module directly (keeps lib.ts the single public surface).
import type { AccountParser } from "./parsers/types.js";
export type { AccountParser };
