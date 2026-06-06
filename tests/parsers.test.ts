/**
 * Tests for venue account parsers (Option-A flow per signer's 21:50 report).
 *
 * Each parser is tolerance-checked against:
 *   - the documented happy-path response
 *   - missing fields (must NOT throw — return zeros/empty)
 *   - zeroed positions (must be filtered out)
 *   - malformed numeric strings
 */

import { describe, expect, it } from "vitest";

import { getAccountParser } from "../src/parsers/index.js";
import { parseBinanceAccount } from "../src/parsers/binance.js";
import { parseOkxAccount } from "../src/parsers/okx.js";
import { parseAsterdexAccount } from "../src/parsers/asterdex.js";

describe("getAccountParser dispatcher", () => {
  it("returns the right parser for each known venue", () => {
    expect(getAccountParser("binance")).toBe(parseBinanceAccount);
    expect(getAccountParser("okx")).toBe(parseOkxAccount);
    expect(getAccountParser("asterdex")).toBe(parseAsterdexAccount);
  });

  it("returns undefined for unknown venue", () => {
    expect(getAccountParser("bitmex")).toBeUndefined();
    expect(getAccountParser("")).toBeUndefined();
  });
});

describe("parseBinanceAccount", () => {
  it("parses a typical /fapi/v2/account response", () => {
    const raw = {
      totalMarginBalance: "10000.00",
      totalUnrealizedProfit: "12.34",
      availableBalance: "8500.50",
      updateTime: 1717180800000,
      positions: [
        {
          symbol: "BTCUSDT",
          positionAmt: "0.002",
          entryPrice: "67120.5",
          unrealizedProfit: "1.23",
        },
        {
          symbol: "ETHUSDT",
          positionAmt: "-0.5",
          entryPrice: "3800.0",
          unrealizedProfit: "-2.5",
        },
      ],
    };
    const out = parseBinanceAccount(raw);
    expect(out.venue).toBe("binance");
    expect(out.equity_usd).toBe(10000.0);
    expect(out.free_margin_usd).toBe(8500.5);
    expect(out.positions).toHaveLength(2);
    expect(out.positions[0]).toMatchObject({
      symbol: "BTCUSDT",
      qty: 0.002,
      entry_price: 67120.5,
      unrealized_pnl: 1.23,
    });
    expect(out.positions[1].qty).toBe(-0.5);
    expect(out.updated_at).toMatch(/^2024-/);
  });

  it("filters out zero-quantity positions", () => {
    const raw = {
      totalMarginBalance: "1000",
      availableBalance: "1000",
      updateTime: 1717180800000,
      positions: [
        { symbol: "BTCUSDT", positionAmt: "0", entryPrice: "0", unrealizedProfit: "0" },
        { symbol: "ETHUSDT", positionAmt: "0.5", entryPrice: "3800", unrealizedProfit: "0" },
      ],
    };
    const out = parseBinanceAccount(raw);
    expect(out.positions).toHaveLength(1);
    expect(out.positions[0].symbol).toBe("ETHUSDT");
  });

  it("does not throw on missing fields", () => {
    const out = parseBinanceAccount({});
    expect(out.venue).toBe("binance");
    expect(out.equity_usd).toBe(0);
    expect(out.free_margin_usd).toBe(0);
    expect(out.positions).toEqual([]);
  });

  it("does not throw on malformed numeric strings", () => {
    const raw = {
      totalMarginBalance: "not-a-number",
      availableBalance: "",
      updateTime: 1717180800000,
      positions: [
        { symbol: "BTCUSDT", positionAmt: "abc", entryPrice: "67000", unrealizedProfit: "0" },
      ],
    };
    const out = parseBinanceAccount(raw);
    expect(out.equity_usd).toBe(0);
    expect(out.free_margin_usd).toBe(0);
    // qty=0 (parse failed) → filtered out
    expect(out.positions).toEqual([]);
  });

  it("does not throw on null input", () => {
    expect(() => parseBinanceAccount(null)).not.toThrow();
    expect(() => parseBinanceAccount(undefined)).not.toThrow();
  });
});

describe("parseOkxAccount", () => {
  it("parses balance + positions composite payload", () => {
    const raw = {
      balance: {
        code: "0",
        data: [
          {
            totalEq: "10000.00",
            adjEq: "8500.00",
            uTime: "1717180800000",
            details: [
              { ccy: "USDT", availBal: "8000.00" },
              { ccy: "USDC", availBal: "500.00" },
              { ccy: "BTC", availBal: "0.02" }, // non-stable, ignored
            ],
          },
        ],
      },
      positions: {
        code: "0",
        data: [
          {
            instId: "BTC-USDT-SWAP",
            pos: "0.002",
            avgPx: "67120.5",
            upl: "1.23",
            markPx: "67200.0",
          },
        ],
      },
    };
    const out = parseOkxAccount(raw);
    expect(out.venue).toBe("okx");
    expect(out.equity_usd).toBe(10000.0);
    // USDT + USDC = 8500
    expect(out.free_margin_usd).toBe(8500.0);
    expect(out.positions).toHaveLength(1);
    expect(out.positions[0]).toMatchObject({
      symbol: "BTC-USDT-SWAP",
      qty: 0.002,
      mark_price: 67200.0,
    });
  });

  it("falls back to adjEq when no stable collateral in details", () => {
    const raw = {
      balance: {
        code: "0",
        data: [
          {
            totalEq: "10000",
            adjEq: "9500",
            details: [{ ccy: "BTC", availBal: "0.1" }],
          },
        ],
      },
    };
    const out = parseOkxAccount(raw);
    expect(out.free_margin_usd).toBe(9500);
  });

  it("returns empty positions when positions payload is missing", () => {
    const raw = {
      balance: { code: "0", data: [{ totalEq: "100", details: [] }] },
    };
    const out = parseOkxAccount(raw);
    expect(out.positions).toEqual([]);
    expect(out.equity_usd).toBe(100);
  });

  it("filters zero-pos rows", () => {
    const raw = {
      balance: { code: "0", data: [{ totalEq: "0", details: [] }] },
      positions: {
        code: "0",
        data: [
          { instId: "BTC-USDT-SWAP", pos: "0", avgPx: "0", upl: "0" },
          { instId: "ETH-USDT-SWAP", pos: "-1", avgPx: "3800", upl: "-2" },
        ],
      },
    };
    const out = parseOkxAccount(raw);
    expect(out.positions).toHaveLength(1);
    expect(out.positions[0].symbol).toBe("ETH-USDT-SWAP");
    expect(out.positions[0].qty).toBe(-1);
  });

  it("does not throw on completely missing input", () => {
    expect(() => parseOkxAccount({})).not.toThrow();
    expect(() => parseOkxAccount(null)).not.toThrow();
  });
});

describe("parseAsterdexAccount", () => {
  it("parses expected v0 shape from indexer", () => {
    const raw = {
      wallet: "0xabc",
      equity_usd: "10000.0",
      available_margin_usd: "8500.0",
      positions: [
        {
          market: "BTC-USD",
          size: "0.001",
          entry_price: "67000.0",
          mark_price: "67200.0",
          unrealized_pnl_usd: "0.2",
        },
      ],
      block_timestamp: 1717180800,
    };
    const out = parseAsterdexAccount(raw);
    expect(out.venue).toBe("asterdex");
    expect(out.equity_usd).toBe(10000.0);
    expect(out.free_margin_usd).toBe(8500.0);
    expect(out.positions[0]).toMatchObject({
      symbol: "BTC-USD",
      qty: 0.001,
      mark_price: 67200.0,
    });
    // Block timestamp seconds → ISO 2024-05-31
    expect(out.updated_at).toMatch(/^2024-05-31/);
  });

  it("handles ms-precision block_timestamp too", () => {
    const out = parseAsterdexAccount({ block_timestamp: 1717180800000 });
    expect(out.updated_at).toMatch(/^2024-05-31/);
  });

  it("filters zeroed positions", () => {
    const raw = {
      equity_usd: "0",
      available_margin_usd: "0",
      positions: [
        { market: "BTC-USD", size: "0", entry_price: "0", unrealized_pnl_usd: "0" },
        { market: "ETH-USD", size: "1", entry_price: "3800", unrealized_pnl_usd: "0" },
      ],
    };
    const out = parseAsterdexAccount(raw);
    expect(out.positions).toHaveLength(1);
    expect(out.positions[0].symbol).toBe("ETH-USD");
  });

  it("tolerates missing input", () => {
    expect(() => parseAsterdexAccount({})).not.toThrow();
    expect(() => parseAsterdexAccount(null)).not.toThrow();
    const out = parseAsterdexAccount({});
    expect(out.equity_usd).toBe(0);
    expect(out.positions).toEqual([]);
  });
});
