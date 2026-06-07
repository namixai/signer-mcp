/**
 * Hyperliquid (L1 perp) account parser — registered under venue id
 * `hyperliquid_main` (matches the gateway's canonical venue id).
 *
 * Unlike the CEX venues, Hyperliquid account state is ONE public read:
 *   POST https://api.hyperliquid.xyz/info   body: {"type":"clearinghouseState","user":"0x..."}
 *
 * This endpoint is unauthenticated (keyed by the user address), so under the
 * Option-A architecture signer's `/account/hyperliquid_main` returns a single
 * signed-or-unsigned request; signer-mcp submits it and hands this parser the
 * raw `clearinghouseState` payload directly (a single object, NOT a composite).
 *
 * Expected shape (only the fields we use):
 *   {
 *     "marginSummary": {
 *       "accountValue": "10000.0",       // total equity
 *       "totalMarginUsed": "1500.0",
 *       "totalNtlPos": "...",
 *       "totalRawUsd": "..."
 *     },
 *     "withdrawable": "8500.0",          // free margin
 *     "assetPositions": [
 *       {
 *         "type": "oneWay",
 *         "position": {
 *           "coin": "BTC",               // symbol = coin name
 *           "szi": "0.002",              // signed size (+ long, − short)
 *           "entryPx": "67120.5",
 *           "positionValue": "...",
 *           "unrealizedPnl": "1.23"
 *         }
 *       }
 *     ],
 *     "time": 1717180800000
 *   }
 *
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
 *
 * Quirks:
 *   - Hyperliquid returns numbers as STRINGS.
 *   - `szi` is the signed position size — no separate side field.
 *   - No mark price on clearinghouseState; left undefined (agent can pull it
 *     from the `allMids` / `metaAndAssetCtxs` info calls if needed).
 *   - `coin` is the bare asset (e.g. "BTC"), not a pair.
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

export const parseHyperliquidAccount: AccountParser = (raw): NormalizedAccount => {
  const obj = (raw as Record<string, unknown>) ?? {};
  const marginSummary = (obj.marginSummary as Record<string, unknown>) ?? {};
  const assetPositions = Array.isArray(obj.assetPositions) ? obj.assetPositions : [];

  const positions: NormalizedPosition[] = [];
  for (const ap of assetPositions) {
    const wrapper = (ap as Record<string, unknown>) ?? {};
    const pos = (wrapper.position as Record<string, unknown>) ?? {};
    const qty = toNum(pos.szi);
    if (qty === 0) continue;
    const symbol = String(pos.coin ?? "");
    if (symbol === "") continue;
    positions.push({
      symbol,
      qty,
      entry_price: toNum(pos.entryPx),
      unrealized_pnl: toNum(pos.unrealizedPnl),
      // No mark price on clearinghouseState — intentionally undefined.
    });
  }

  const timeMs = obj.time;
  const updated_at =
    typeof timeMs === "number" && Number.isFinite(timeMs)
      ? new Date(timeMs).toISOString()
      : new Date(0).toISOString();

  return {
    venue: "hyperliquid_main",
    equity_usd: toNum(marginSummary.accountValue),
    free_margin_usd: toNum(obj.withdrawable),
    positions,
    updated_at,
  };
};
