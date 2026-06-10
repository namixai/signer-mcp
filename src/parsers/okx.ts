/**
 * OKX v5 account parser.
 *
 * OKX splits balance and positions across TWO endpoints:
 *   GET /api/v5/account/balance   → equity + free margin
 *   GET /api/v5/account/positions → open positions
 *
 * For the Option-A architecture this means signer's `/account/<venue>` for
 * OKX may need to return TWO signed requests (or one composite). For v0 we
 * accept a combined raw payload:
 *
 *   {
 *     "balance":   { ...OKX /balance response... },
 *     "positions": { ...OKX /positions response... }
 *   }
 *
 * If only `balance` is present (positions response missing), we still emit
 * a valid NormalizedAccount with empty positions — the agent can decide.
 *
 * OKX response wrapper: { "code": "0", "msg": "", "data": [ {...} ] }
 * Single-element data arrays are typical for these endpoints.
 *
 * Docs:
 *   https://www.okx.com/docs-v5/en/#trading-account-rest-api-get-balance
 *   https://www.okx.com/docs-v5/en/#trading-account-rest-api-get-positions
 *
 * Quirks:
 *   - OKX returns numbers as strings (like Binance).
 *   - Empty equity field returns "" not null.
 *   - Positions array can include zeroed-out rows after closes; filter them.
 *   - `instId` is OKX's symbol field (e.g. "BTC-USDT-SWAP").
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

function unwrapOkxArray(payload: unknown): Record<string, unknown> | null {
  // Standard shape: { code: "0", data: [ {...} ] }
  const obj = payload as Record<string, unknown>;
  if (!obj || !Array.isArray(obj.data)) return null;
  const first = obj.data[0];
  return (first as Record<string, unknown>) ?? null;
}

export const parseOkxAccount: AccountParser = (raw): NormalizedAccount => {
  const wrap = (raw as Record<string, unknown>) ?? {};
  // Bug #136: a failed/blocked OKX execute must surface as an error, never as a
  // fabricated $0 balance. Validate the balance leg is a real OKX success first.
  const balRaw = wrap.balance;
  if (balRaw === undefined || balRaw === null || typeof balRaw !== "object") {
    throw new Error(
      `OKX balance response missing or non-JSON — the exchange call likely failed ` +
        `or was blocked at the edge, not an empty account. Got: ${String(balRaw).slice(0, 160)}`,
    );
  }
  // Same fabrication class, different vector (0.2.3 hardening): a RAW
  // unexecuted signed-request ({method,url,headers}) reaching the parser must
  // never normalize to $0 — it means a composite leg was recognized as
  // pass-through instead of being executed.
  const balObj = balRaw as Record<string, unknown>;
  if (
    typeof balObj.method === "string" &&
    typeof balObj.url === "string" &&
    balObj.code === undefined &&
    balObj.data === undefined
  ) {
    throw new Error(
      "OKX balance leg was never executed (raw signed-request reached the parser) — " +
        "client bug, not an empty account. Report this; do not trust a $0 reading.",
    );
  }
  const balCode = (balRaw as Record<string, unknown>).code;
  if (balCode !== undefined && String(balCode) !== "0") {
    throw new Error(
      `OKX returned error code ${String(balCode)}: ` +
        `${String((balRaw as Record<string, unknown>).msg ?? "").slice(0, 160)}`,
    );
  }
  const balanceWrap = unwrapOkxArray(wrap.balance);
  const positionsWrap = wrap.positions as Record<string, unknown> | undefined;

  // Equity + free margin from /balance.
  // OKX returns multi-currency `details: [...]` per account; we sum USDT/USDC
  // available balances and use totalEq (already USD-normalized).
  const equity = toNum(balanceWrap?.totalEq);
  let freeMargin = 0;
  const details = Array.isArray(balanceWrap?.details) ? balanceWrap?.details : [];
  for (const d of details as Array<Record<string, unknown>>) {
    const ccy = String(d.ccy ?? "");
    if (ccy === "USDT" || ccy === "USDC" || ccy === "USD") {
      // availBal is the spendable balance in that currency. Sum across stable
      // collateral types — close enough for v0 USD-equivalent.
      freeMargin += toNum(d.availBal);
    }
  }
  // Fallback: if no stable collateral row, use adjEq as a rough proxy.
  if (freeMargin === 0) {
    freeMargin = toNum(balanceWrap?.adjEq);
  }

  // Positions from /positions.
  const positions: NormalizedPosition[] = [];
  if (positionsWrap && Array.isArray(positionsWrap.data)) {
    for (const p of positionsWrap.data as Array<Record<string, unknown>>) {
      const qty = toNum(p.pos);
      if (qty === 0) continue;
      const symbol = String(p.instId ?? "");
      if (symbol === "") continue;
      positions.push({
        symbol,
        qty,
        entry_price: toNum(p.avgPx),
        unrealized_pnl: toNum(p.upl),
        mark_price: p.markPx !== undefined ? toNum(p.markPx) : undefined,
      });
    }
  }

  // OKX gives uTime / cTime (timestamps in ms) — use balance.uTime when present.
  const ts = balanceWrap?.uTime;
  const updated_at =
    typeof ts === "string" && ts.length > 0
      ? new Date(parseInt(ts, 10)).toISOString()
      : new Date(0).toISOString();

  return {
    venue: "okx",
    equity_usd: equity,
    free_margin_usd: freeMargin,
    positions,
    updated_at,
  };
};
