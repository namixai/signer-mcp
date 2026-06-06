/**
 * Asterdex account parser — v0 stub.
 *
 * Asterdex is a BSC on-chain perp DEX. Account state lives on-chain (margin
 * vault + position records), so the "account" read isn't a single REST call
 * — it's reading contract state via JSON-RPC or their indexer.
 *
 * For v0, we expect signer's gateway to return a combined payload from the
 * indexer (the signer worker handles this — it's their decision how to
 * shape it). Our parser is tolerant: if the shape matches the expected v0
 * draft, we parse; otherwise return zeros with the raw timestamp.
 *
 * Expected v0 shape (subject to signer worker confirming):
 *   {
 *     "wallet": "0x...",
 *     "equity_usd": "10000.0",       // already USD from the indexer
 *     "available_margin_usd": "8500.0",
 *     "positions": [
 *       {
 *         "market": "BTC-USD",
 *         "size": "0.001",            // signed
 *         "entry_price": "67000.0",
 *         "mark_price": "67200.0",
 *         "unrealized_pnl_usd": "0.2"
 *       }
 *     ],
 *     "block_timestamp": 1717180800
 *   }
 *
 * If the signer worker chooses a different shape, this parser is the only
 * file that needs to change to absorb it — the public NormalizedAccount
 * contract stays stable.
 */

import type { AccountParser, NormalizedAccount, NormalizedPosition } from "./types.js";

function toNum(v: unknown, fallback = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string" && v.length > 0) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export const parseAsterdexAccount: AccountParser = (raw): NormalizedAccount => {
  const obj = (raw as Record<string, unknown>) ?? {};
  const positionsRaw = Array.isArray(obj.positions) ? obj.positions : [];

  const positions: NormalizedPosition[] = [];
  for (const p of positionsRaw) {
    const r = (p as Record<string, unknown>) ?? {};
    const qty = toNum(r.size);
    if (qty === 0) continue;
    const symbol = String(r.market ?? "");
    if (symbol === "") continue;
    const out: NormalizedPosition = {
      symbol,
      qty,
      entry_price: toNum(r.entry_price),
      unrealized_pnl: toNum(r.unrealized_pnl_usd),
    };
    if (r.mark_price !== undefined) out.mark_price = toNum(r.mark_price);
    positions.push(out);
  }

  let updated_at = new Date(0).toISOString();
  if (typeof obj.block_timestamp === "number" && Number.isFinite(obj.block_timestamp)) {
    // Block timestamps are typically seconds, not ms.
    const ms = obj.block_timestamp > 1e12 ? obj.block_timestamp : obj.block_timestamp * 1000;
    updated_at = new Date(ms).toISOString();
  }

  return {
    venue: "asterdex",
    equity_usd: toNum(obj.equity_usd),
    free_margin_usd: toNum(obj.available_margin_usd),
    positions,
    updated_at,
  };
};
