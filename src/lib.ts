/**
 * Core handlers and helpers for @usenami/signer-mcp.
 *
 * Extracted from index.ts so unit tests can exercise the gateway-call paths
 * without booting a real MCP transport. index.ts wires these into MCP tools.
 */

export const PACKAGE_VERSION = "0.1.1";
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

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
      headers: req.headers,
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
      // Some venues return non-JSON on success (rare). Pass through as string.
      return text;
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
  try {
    // Per CTO 2026-05-31T2240 decision: PER-VENUE endpoints (not a generic
    // /sign/order). Each venue puts policy-relevant fields (symbol/qty/side)
    // in a different location — Binance in query string, OKX in JSON body,
    // Asterdex inside the EIP-712 message. Per-venue handlers enforce policy
    // on the actual fields; a generic endpoint would muddy that.
    const signed = await callGateway<unknown>(
      `/sign/${encodeURIComponent(args.venue)}-order`,
      { method: "POST", body: args, authRequired: true },
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
  if ((venue === "binance" || venue === "okx") && !args.symbol) {
    return toolError(
      `cancel_order on "${args.venue}" requires "symbol" — its cancel REST route ` +
        `needs the venue-native symbol (e.g. BTCUSDT) alongside order_id.`,
    );
  }
  try {
    // Per-venue endpoint per CTO decision (same rationale as place_order).
    const signed = await callGateway<unknown>(
      `/sign/${encodeURIComponent(args.venue)}-cancel`,
      { method: "POST", body: args, authRequired: true },
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
