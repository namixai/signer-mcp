/**
 * KuCoin Futures account parser.
 *
 * Like OKX, KuCoin Futures splits balance and positions across TWO endpoints:
 *   GET /api/v1/account-overview?currency=USDT  → equity + free margin
 *   GET /api/v1/positions                        → open positions
 *
 * Under the Option-A architecture, signer's `/account/kucoin` returns a
 * composite of two signed requests; signer-mcp submits both and hands this
 * parser the combined payload:
 *
 *   {
 *     "balance":   { ...KuCoin /account-overview response... },
 *     "positions": { ...KuCoin /positions response... }
 *   }
 *
 * KuCoin wrapper: { "code": "200000", "data": <object | array> }.
 *   - /account-overview → data is a single OBJECT.
 *   - /positions        → data is an ARRAY.
 *
 * Docs:
 *   https://www.kucoin.com/docs/rest/futures-trading/account/get-account-overview
 *   https://www.kucoin.com/docs/rest/futures-trading/positions/get-position-list
 *
 * Quirks:
 *   - KuCoin Futures returns numbers as JSON NUMBERS (not strings like Binance
 *     / OKX). toNum handles both for safety.
 *   - `currentQty` is in CONTRACTS, signed (+ long, − short). We pass it through
 *     as the normalized qty — the agent interprets contract size per symbol.
 *   - Positions list includes `isOpen:false` / zero-qty rows after closes;
 *     filter them out.
 *   - `symbol` is the KuCoin Futures contract code, e.g. "XBTUSDTM".
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

function unwrapKucoinObject(payload: unknown): Record<string, unknown> | null {
  // Standard shape: { code: "200000", data: { ... } }
  const obj = payload as Record<string, unknown>;
  if (!obj || typeof obj.data !== "object" || obj.data === null) return null;
  if (Array.isArray(obj.data)) return null;
  return obj.data as Record<string, unknown>;
}

function unwrapKucoinArray(payload: unknown): Array<Record<string, unknown>> {
  const obj = payload as Record<string, unknown>;
  if (!obj || !Array.isArray(obj.data)) return [];
  return obj.data as Array<Record<string, unknown>>;
}

export const parseKucoinAccount: AccountParser = (raw): NormalizedAccount => {
  const wrap = (raw as Record<string, unknown>) ?? {};
  const balanceData = unwrapKucoinObject(wrap.balance);
  const positionsArr = unwrapKucoinArray(wrap.positions);

  const equity = toNum(balanceData?.accountEquity);
  const freeMargin = toNum(balanceData?.availableBalance);

  const positions: NormalizedPosition[] = [];
  for (const p of positionsArr) {
    const r = p ?? {};
    const qty = toNum(r.currentQty);
    if (qty === 0) continue;
    const symbol = String(r.symbol ?? "");
    if (symbol === "") continue;
    const out: NormalizedPosition = {
      symbol,
      qty,
      entry_price: toNum(r.avgEntryPrice),
      unrealized_pnl: toNum(r.unrealisedPnl),
    };
    if (r.markPrice !== undefined) out.mark_price = toNum(r.markPrice);
    positions.push(out);
  }

  return {
    venue: "kucoin",
    equity_usd: equity,
    free_margin_usd: freeMargin,
    positions,
    // KuCoin Futures account-overview has no reliable server timestamp; use the
    // epoch sentinel so callers can detect "venue gave no time".
    updated_at: new Date(0).toISOString(),
  };
};
