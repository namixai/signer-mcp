/**
 * Common shapes for venue parsers under the Option-A architecture (signer
 * returns signed read request, signer-mcp executes it + parses).
 *
 * Per signer's 2026-05-31T2150 schema-coordination report. The MCP tool
 * contract returns this normalized shape — venue-specific quirks live
 * inside each parser.
 */

export interface NormalizedAccount {
  /**
   * Venue id (binance, okx, asterdex, kucoin, bybit, hyperliquid_main) —
   * echoed for agent introspection.
   */
  venue: string;
  /**
   * Total margin balance in USD-equivalent. Some venues return USDT-collat;
   * we treat USDT as USD for v0 (acceptable for the demo, real conversion
   * via mark price comes in v0.1).
   */
  equity_usd: number;
  /**
   * Free margin = equity - used by open positions. Used for `place_order`
   * pre-checks ("do I have margin?").
   */
  free_margin_usd: number;
  /** Per-symbol open positions. Empty array when flat. */
  positions: NormalizedPosition[];
  /**
   * Server-side timestamp from the venue. ISO 8601 if the venue gives one,
   * otherwise a normalized fetch timestamp (parser sets it).
   */
  updated_at: string;
}

export interface NormalizedPosition {
  symbol: string;
  /**
   * Signed quantity in base asset. Positive = long, negative = short. Zero
   * positions are filtered out before returning.
   */
  qty: number;
  /** Volume-weighted average entry price. */
  entry_price: number;
  /** Unrealized PnL in venue's quote/collat currency. */
  unrealized_pnl: number;
  /** Mark price if the venue provides it (Binance does, OKX does, Asterdex partial). */
  mark_price?: number;
}

export interface SignedRequest {
  venue: string;
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * A parser turns a venue's raw account-endpoint response into our normalized
 * shape. Each parser knows ONE venue's quirks; the dispatcher in
 * parsers/index.ts picks the right one based on venue id.
 *
 * Parsers MUST be tolerant: missing fields → return 0 or [], never throw.
 * Throwing in a parser cascades to the tool error path, which kills the
 * agent's ability to call place_order even when the account read partially
 * worked.
 */
export type AccountParser = (raw: unknown) => NormalizedAccount;
