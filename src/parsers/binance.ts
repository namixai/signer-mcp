/**
 * Binance USD-M Futures account parser.
 *
 * Endpoint: GET /fapi/v2/account
 * Docs: https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Account-Information-V2
 *
 * Schema (only the fields we use):
 *   {
 *     "totalMarginBalance": "10000.00",   // total equity
 *     "totalUnrealizedProfit": "12.34",
 *     "availableBalance": "8500.00",      // free margin
 *     "updateTime": 1717180800000,
 *     "positions": [
 *       {
 *         "symbol": "BTCUSDT",
 *         "positionAmt": "0.002",         // signed: + long, - short
 *         "entryPrice": "67120.5",
 *         "unrealizedProfit": "1.23",
 *         "markPrice": "67200.0"          // not in /v2/account; we leave undefined
 *       }
 *     ]
 *   }
 *
 * Notes on quirks:
 *   - Binance returns numbers as strings — parseFloat with NaN guards.
 *   - positionAmt "0" rows appear for every symbol the account has ever
 *     traded; we filter them out so the agent only sees real positions.
 *   - markPrice isn't on /v2/account — it's on /v1/premiumIndex per-symbol.
 *     Leave undefined; agent uses get_orderbook or similar if needed.
 */

import type { AccountParser, NormalizedAccount, NormalizedPosition } from "./types.js";

function toNum(v: unknown, fallback = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function toIso(updateTime: unknown): string {
  if (typeof updateTime === "number" && Number.isFinite(updateTime)) {
    return new Date(updateTime).toISOString();
  }
  return new Date(0).toISOString(); // epoch sentinel — caller can detect
}

export const parseBinanceAccount: AccountParser = (raw): NormalizedAccount => {
  const obj = (raw as Record<string, unknown>) ?? {};
  // Bug #136: Binance error responses are `{ code: <negative>, msg }`. A success
  // account snapshot has no top-level numeric `code`. Surface the error instead
  // of fabricating a $0 balance from a response that has no balance fields.
  if (typeof obj.code === "number" && obj.code < 0) {
    throw new Error(
      `Binance returned error code ${obj.code}: ${String(obj.msg ?? "").slice(0, 160)}`,
    );
  }
  const positionsRaw = Array.isArray(obj.positions) ? obj.positions : [];

  const positions: NormalizedPosition[] = positionsRaw
    .map((p) => {
      const r = (p as Record<string, unknown>) ?? {};
      const qty = toNum(r.positionAmt);
      if (qty === 0) return null;
      return {
        symbol: String(r.symbol ?? ""),
        qty,
        entry_price: toNum(r.entryPrice),
        unrealized_pnl: toNum(r.unrealizedProfit),
        // markPrice intentionally undefined — not on /v2/account
      } satisfies NormalizedPosition;
    })
    .filter((p): p is NormalizedPosition => p !== null && p.symbol !== "");

  return {
    venue: "binance",
    equity_usd: toNum(obj.totalMarginBalance),
    free_margin_usd: toNum(obj.availableBalance),
    positions,
    updated_at: toIso(obj.updateTime),
  };
};
