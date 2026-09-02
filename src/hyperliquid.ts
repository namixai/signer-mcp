/**
 * Hyperliquid order route — the EIP-712 half of `place_order` / `cancel_order`.
 *
 * WHY THIS IS A MODULE AND NOT A LINE IN `STRUCTURED_ORDER_VENUES`
 * ---------------------------------------------------------------
 * Binance and OKX are HMAC venues: the gateway has a structured route per venue,
 * takes `{symbol, side, qty, ord_type, price}` and hands back an HTTP request to
 * fire. Hyperliquid is not that. The signature commits to an ACTION OBJECT, not
 * to an HTTP request line, and that object is addressed by an INTEGER ASSET
 * INDEX rather than a symbol. So four things have to happen here that have no
 * analogue on the HMAC venues:
 *
 *   1. resolve coin → asset index from Hyperliquid's own `meta`;
 *   2. format size and price to the per-asset rules (`szDecimals`);
 *   3. build the action object the signature will cover;
 *   4. submit to `/exchange` in Hyperliquid's own envelope.
 *
 * 🔴 STEP 1 IS THE DANGEROUS ONE. The index is what says WHICH ASSET the order
 * is for. Guess it and the enclave signs a real order on a different market — a
 * money error, not a request error, and the signature makes it authentic. So the
 * index is only ever read from the venue's own metadata, never inferred from
 * position in a list we cached loosely, and an unknown coin fails closed with a
 * message rather than defaulting to anything.
 *
 * 🔴 HYPERLIQUID HAS NO MARKET ORDER. Its API expresses "market" as an
 * aggressively-priced IOC limit. Synthesising one here would mean this package
 * choosing a slippage bound on someone else's money, silently. It refuses
 * instead and says what to send — the caller picks the price, because the caller
 * is the one who bears the fill.
 */

import { NormalizationError } from "./normalize.js";

/**
 * Both networks, because rehearsing a money scene on testnet costs nothing and
 * catches shape errors that would otherwise be caught by a real order. The
 * enclave already separates them (`sign_hyperliquid_main_*` vs `_testnet_*`,
 * differing in the phantom-agent source byte), so the client must not blur them
 * either: the venue id picks the host, and there is no default.
 */
const HL_HOSTS: Record<string, string> = {
  hyperliquid_main: "https://api.hyperliquid.xyz",
  hyperliquid_testnet: "https://api.hyperliquid-testnet.xyz",
};

export const EIP712_ORDER_VENUES = new Set(Object.keys(HL_HOSTS));

export function hlHost(venue: string): string {
  const host = HL_HOSTS[venue];
  if (!host) {
    throw new NormalizationError(`"${venue}" is not a Hyperliquid venue`);
  }
  return host;
}

/**
 * Perp price rule: at most `MAX_DECIMALS - szDecimals` decimal places.
 * (Spot uses 8; this route is perps only.)
 */
const HL_PERP_MAX_DECIMALS = 6;
/** Prices carry at most 5 significant figures — integers are exempt. */
const HL_PRICE_SIG_FIGS = 5;

export interface HlAsset {
  /** Index into the perp universe — what the signature actually commits to. */
  index: number;
  name: string;
  szDecimals: number;
}

/**
 * Cache of the perp universe. Process-lifetime: the universe changes when
 * Hyperliquid lists an asset, which is rare, and a stale cache can only fail
 * CLOSED here (an unknown coin is refused) — it can never point an order at the
 * wrong asset, because the mapping is name → index, not position → index.
 */
const universeCache = new Map<string, Map<string, HlAsset>>();

export function resetUniverseCacheForTests(): void {
  universeCache.clear();
}

export async function loadUniverse(
  venue: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<Map<string, HlAsset>> {
  const cached = universeCache.get(venue);
  if (cached) return cached;
  const infoUrl = `${hlHost(venue)}/info`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body: unknown;
  try {
    const res = await fetchImpl(infoUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "meta" }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(
        `Hyperliquid /info (${venue}) returned HTTP ${res.status} — cannot resolve asset index`,
      );
    }
    body = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const universe = (body as { universe?: unknown })?.universe;
  if (!Array.isArray(universe) || universe.length === 0) {
    throw new Error("Hyperliquid /info returned no universe — refusing to guess an asset index");
  }
  const map = new Map<string, HlAsset>();
  universe.forEach((entry, index) => {
    const name = (entry as { name?: unknown })?.name;
    const szDecimals = (entry as { szDecimals?: unknown })?.szDecimals;
    if (typeof name !== "string" || typeof szDecimals !== "number") return;
    map.set(name.toUpperCase(), { index, name, szDecimals });
  });
  if (map.size === 0) {
    throw new Error("Hyperliquid /info universe had no usable entries");
  }
  universeCache.set(venue, map);
  return map;
}

export async function resolveAsset(
  venue: string,
  coin: string,
  fetchImpl?: typeof fetch,
  timeoutMs?: number,
): Promise<HlAsset> {
  const map = await loadUniverse(venue, fetchImpl, timeoutMs);
  const asset = map.get(coin.toUpperCase());
  if (!asset) {
    throw new NormalizationError(
      `"${coin}" is not a Hyperliquid perp — it is not in the venue's own asset list. ` +
        `Refusing to sign: the asset index is what the signature commits to, and a wrong ` +
        `index would place a real order on a different market.`,
    );
  }
  return asset;
}

/** Size, rounded to the asset's own precision. Rejects a size that rounds to zero. */
export function formatSize(qty: number, szDecimals: number): string {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new NormalizationError(`qty must be a positive finite number, got ${qty}`);
  }
  const s = qty.toFixed(szDecimals);
  if (Number(s) === 0) {
    throw new NormalizationError(
      `qty ${qty} rounds to zero at ${szDecimals} decimals for this asset — too small to trade`,
    );
  }
  return trimZeros(s);
}

/**
 * Price under Hyperliquid's two rules at once: at most 5 significant figures,
 * and at most `6 - szDecimals` decimal places. Integers are exempt from the
 * significant-figure rule, which is why the integer case is checked first.
 */
export function formatPrice(px: number, szDecimals: number): string {
  if (!Number.isFinite(px) || px <= 0) {
    throw new NormalizationError(`price must be a positive finite number, got ${px}`);
  }
  const maxDecimals = Math.max(0, HL_PERP_MAX_DECIMALS - szDecimals);
  if (Number.isInteger(px)) return String(px);
  const bySigFigs = Number(px.toPrecision(HL_PRICE_SIG_FIGS));
  const s = bySigFigs.toFixed(maxDecimals);
  if (Number(s) === 0) {
    throw new NormalizationError(
      `price ${px} rounds to zero at ${maxDecimals} decimals for this asset`,
    );
  }
  return trimZeros(s);
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export interface HlOrderActionInput {
  asset: HlAsset;
  isBuy: boolean;
  price: string;
  size: string;
  reduceOnly: boolean;
}

/**
 * The order action. Key order matters: the enclave forwards this object
 * verbatim and the signature covers its serialisation, so the shape here is the
 * shape that gets signed.
 */
export function buildOrderAction(i: HlOrderActionInput): Record<string, unknown> {
  return {
    type: "order",
    orders: [
      {
        a: i.asset.index,
        b: i.isBuy,
        p: i.price,
        s: i.size,
        r: i.reduceOnly,
        t: { limit: { tif: "Gtc" } },
      },
    ],
    grouping: "na",
  };
}

export function buildCancelAction(asset: HlAsset, oid: number): Record<string, unknown> {
  return { type: "cancel", cancels: [{ a: asset.index, o: oid }] };
}

/** Hyperliquid order ids are integers; a non-integer would be silently mangled. */
export function parseOid(orderId: string): number {
  const n = Number(orderId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new NormalizationError(
      `Hyperliquid order_id must be a positive integer (its "oid"), got "${orderId}"`,
    );
  }
  return n;
}

export interface HlSignature {
  r: string;
  s: string;
  v: number;
}

/**
 * Submit the enclave-signed action. This package never signs — it carries.
 */
export async function submitAction(
  venue: string,
  action: Record<string, unknown>,
  nonce: number,
  signature: HlSignature,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
  vaultAddress: string | null = null,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${hlHost(venue)}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, nonce, signature, vaultAddress }),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text.slice(0, 2000);
    }
    if (!res.ok) {
      throw new Error(`Hyperliquid /exchange returned HTTP ${res.status}: ${JSON.stringify(parsed)}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}
