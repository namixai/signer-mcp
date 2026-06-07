/**
 * Bybit V5 (linear perp) account parser.
 *
 * Bybit V5 splits balance and positions across TWO endpoints:
 *   GET /v5/account/wallet-balance?accountType=UNIFIED  → equity + free margin
 *   GET /v5/position/list?category=linear               → open positions
 *
 * Under the Option-A architecture, signer's `/account/bybit` returns a
 * composite of two signed requests; signer-mcp submits both and hands this
 * parser the combined payload:
 *
 *   {
 *     "balance":   { ...Bybit /wallet-balance response... },
 *     "positions": { ...Bybit /position/list response... }
 *   }
 *
 * Bybit wrapper: { "retCode": 0, "retMsg": "OK", "result": { "list": [ ... ] }, "time": 1717180800000 }
 *
 * Docs:
 *   https://bybit-exchange.github.io/docs/v5/account/wallet-balance
 *   https://bybit-exchange.github.io/docs/v5/position
 *
 * Quirks:
 *   - Bybit returns numbers as STRINGS (like Binance / OKX).
 *   - `wallet-balance.result.list[0]` is the unified account summary
 *     (totalEquity, totalAvailableBalance). For the demo we treat the unified
 *     USD-valued totals as USD-equivalent.
 *   - Position `size` is UNSIGNED; the sign comes from `side` ("Buy" = long,
 *     "Sell" = short). Flat rows arrive as size "0" with side "" — filter them.
 *   - `markPrice` is provided on the position row.
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

function firstListEntry(payload: unknown): Record<string, unknown> | null {
  // Shape: { retCode: 0, result: { list: [ {...} ] } }
  const obj = payload as Record<string, unknown>;
  const result = obj?.result as Record<string, unknown> | undefined;
  if (!result || !Array.isArray(result.list)) return null;
  return (result.list[0] as Record<string, unknown>) ?? null;
}

function listEntries(payload: unknown): Array<Record<string, unknown>> {
  const obj = payload as Record<string, unknown>;
  const result = obj?.result as Record<string, unknown> | undefined;
  if (!result || !Array.isArray(result.list)) return [];
  return result.list as Array<Record<string, unknown>>;
}

export const parseBybitAccount: AccountParser = (raw): NormalizedAccount => {
  const wrap = (raw as Record<string, unknown>) ?? {};
  const balanceSummary = firstListEntry(wrap.balance);

  const equity = toNum(balanceSummary?.totalEquity);
  // totalAvailableBalance is the unified-account free balance; fall back to
  // totalMarginBalance only if the field is ABSENT (older account types) —
  // NOT when it's present-and-zero. A legitimately fully-utilized account has
  // totalAvailableBalance "0"; replacing that with the margin balance would
  // overstate free margin and could let a place_order pre-check pass wrongly.
  const availRaw = balanceSummary?.totalAvailableBalance;
  const hasAvail = availRaw !== undefined && availRaw !== null && availRaw !== "";
  const freeMargin = hasAvail
    ? toNum(availRaw)
    : toNum(balanceSummary?.totalMarginBalance);

  const positions: NormalizedPosition[] = [];
  for (const p of listEntries(wrap.positions)) {
    const r = p ?? {};
    const size = toNum(r.size);
    if (size === 0) continue;
    const symbol = String(r.symbol ?? "");
    if (symbol === "") continue;
    // Bybit size is unsigned; side gives direction. Only "Buy"/"Sell" are
    // valid for a live position — a non-zero size with an unknown/empty side
    // is anomalous, so skip it rather than guess a direction (defensive: empty
    // side normally only appears on flat rows, already filtered by size===0).
    const sideStr = String(r.side ?? "").toLowerCase();
    let signedQty: number;
    if (sideStr === "buy") signedQty = size;
    else if (sideStr === "sell") signedQty = -size;
    else continue;
    const out: NormalizedPosition = {
      symbol,
      qty: signedQty,
      entry_price: toNum(r.avgPrice),
      unrealized_pnl: toNum(r.unrealisedPnl),
    };
    if (r.markPrice !== undefined) out.mark_price = toNum(r.markPrice);
    positions.push(out);
  }

  // Top-level `time` is the response timestamp in ms.
  const ts = wrap.balance as Record<string, unknown> | undefined;
  const timeMs = ts?.time;
  const updated_at =
    typeof timeMs === "number" && Number.isFinite(timeMs)
      ? new Date(timeMs).toISOString()
      : new Date(0).toISOString();

  return {
    venue: "bybit",
    equity_usd: equity,
    free_margin_usd: freeMargin,
    positions,
    updated_at,
  };
};
