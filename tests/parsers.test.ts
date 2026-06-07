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
import { parseKucoinAccount } from "../src/parsers/kucoin.js";
import { parseBybitAccount } from "../src/parsers/bybit.js";
import { parseHyperliquidAccount } from "../src/parsers/hyperliquid.js";

describe("getAccountParser dispatcher", () => {
  it("returns the right parser for each known venue", () => {
    expect(getAccountParser("binance")).toBe(parseBinanceAccount);
    expect(getAccountParser("okx")).toBe(parseOkxAccount);
    expect(getAccountParser("asterdex")).toBe(parseAsterdexAccount);
    expect(getAccountParser("kucoin")).toBe(parseKucoinAccount);
    expect(getAccountParser("bybit")).toBe(parseBybitAccount);
    // Gateway's canonical id has the `_main` suffix.
    expect(getAccountParser("hyperliquid_main")).toBe(parseHyperliquidAccount);
  });

  it("returns undefined for unknown venue", () => {
    expect(getAccountParser("bitmex")).toBeUndefined();
    expect(getAccountParser("")).toBeUndefined();
    // `hyperliquid` (without _main) is NOT registered — only the canonical id.
    expect(getAccountParser("hyperliquid")).toBeUndefined();
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

describe("parseKucoinAccount", () => {
  it("parses balance(object) + positions(array) composite payload", () => {
    const raw = {
      balance: {
        code: "200000",
        data: {
          accountEquity: 10000.0,
          availableBalance: 8500.5,
          marginBalance: 9000.0,
          currency: "USDT",
        },
      },
      positions: {
        code: "200000",
        data: [
          {
            symbol: "XBTUSDTM",
            currentQty: 2,
            avgEntryPrice: 67120.5,
            unrealisedPnl: 1.23,
            markPrice: 67200.0,
            isOpen: true,
          },
          {
            symbol: "ETHUSDTM",
            currentQty: -5,
            avgEntryPrice: 3800.0,
            unrealisedPnl: -2.5,
            markPrice: 3790.0,
            isOpen: true,
          },
        ],
      },
    };
    const out = parseKucoinAccount(raw);
    expect(out.venue).toBe("kucoin");
    expect(out.equity_usd).toBe(10000.0);
    expect(out.free_margin_usd).toBe(8500.5);
    expect(out.positions).toHaveLength(2);
    expect(out.positions[0]).toMatchObject({
      symbol: "XBTUSDTM",
      qty: 2,
      entry_price: 67120.5,
      unrealized_pnl: 1.23,
      mark_price: 67200.0,
    });
    expect(out.positions[1].qty).toBe(-5); // short
  });

  it("tolerates string-encoded numbers too", () => {
    const raw = {
      balance: { code: "200000", data: { accountEquity: "5000", availableBalance: "4000" } },
      positions: { code: "200000", data: [] },
    };
    const out = parseKucoinAccount(raw);
    expect(out.equity_usd).toBe(5000);
    expect(out.free_margin_usd).toBe(4000);
  });

  it("filters zero/closed positions", () => {
    const raw = {
      balance: { code: "200000", data: { accountEquity: 100, availableBalance: 100 } },
      positions: {
        code: "200000",
        data: [
          { symbol: "XBTUSDTM", currentQty: 0, avgEntryPrice: 0, unrealisedPnl: 0 },
          { symbol: "ETHUSDTM", currentQty: 3, avgEntryPrice: 3800, unrealisedPnl: 0 },
        ],
      },
    };
    const out = parseKucoinAccount(raw);
    expect(out.positions).toHaveLength(1);
    expect(out.positions[0].symbol).toBe("ETHUSDTM");
  });

  it("returns empty positions when positions payload missing", () => {
    const out = parseKucoinAccount({
      balance: { code: "200000", data: { accountEquity: 100, availableBalance: 90 } },
    });
    expect(out.positions).toEqual([]);
    expect(out.equity_usd).toBe(100);
  });

  it("does not throw on missing/null input", () => {
    expect(() => parseKucoinAccount({})).not.toThrow();
    expect(() => parseKucoinAccount(null)).not.toThrow();
    const out = parseKucoinAccount({});
    expect(out.venue).toBe("kucoin");
    expect(out.equity_usd).toBe(0);
    expect(out.positions).toEqual([]);
  });
});

describe("parseBybitAccount", () => {
  it("parses V5 wallet-balance + position/list composite", () => {
    const raw = {
      balance: {
        retCode: 0,
        retMsg: "OK",
        result: {
          list: [
            {
              accountType: "UNIFIED",
              totalEquity: "10000.00",
              totalAvailableBalance: "8500.00",
              totalMarginBalance: "9000.00",
              coin: [{ coin: "USDT", equity: "10000", availableToWithdraw: "8500" }],
            },
          ],
        },
        time: 1717180800000,
      },
      positions: {
        retCode: 0,
        result: {
          list: [
            {
              symbol: "BTCUSDT",
              side: "Buy",
              size: "0.002",
              avgPrice: "67120.5",
              unrealisedPnl: "1.23",
              markPrice: "67200.0",
            },
            {
              symbol: "ETHUSDT",
              side: "Sell",
              size: "0.5",
              avgPrice: "3800.0",
              unrealisedPnl: "-2.5",
              markPrice: "3790.0",
            },
          ],
        },
      },
    };
    const out = parseBybitAccount(raw);
    expect(out.venue).toBe("bybit");
    expect(out.equity_usd).toBe(10000.0);
    expect(out.free_margin_usd).toBe(8500.0);
    expect(out.positions).toHaveLength(2);
    expect(out.positions[0]).toMatchObject({
      symbol: "BTCUSDT",
      qty: 0.002, // Buy → positive
      mark_price: 67200.0,
    });
    expect(out.positions[1].qty).toBe(-0.5); // Sell → negative
    expect(out.updated_at).toMatch(/^2024-/);
  });

  it("falls back to totalMarginBalance when availableBalance absent", () => {
    const raw = {
      balance: {
        retCode: 0,
        result: { list: [{ totalEquity: "10000", totalMarginBalance: "9500" }] },
      },
    };
    const out = parseBybitAccount(raw);
    expect(out.free_margin_usd).toBe(9500);
  });

  it("does NOT fall back when availableBalance is present-and-zero", () => {
    // Fully-utilized account: real free margin is 0, must not be overstated
    // by falling back to totalMarginBalance.
    const raw = {
      balance: {
        retCode: 0,
        result: {
          list: [{ totalEquity: "10000", totalAvailableBalance: "0", totalMarginBalance: "9500" }],
        },
      },
    };
    const out = parseBybitAccount(raw);
    expect(out.free_margin_usd).toBe(0);
  });

  it("skips a non-zero position with unknown/empty side (no direction guess)", () => {
    const raw = {
      balance: { retCode: 0, result: { list: [{ totalEquity: "0" }] } },
      positions: {
        retCode: 0,
        result: {
          list: [
            { symbol: "BTCUSDT", side: "", size: "0.5", avgPrice: "67000", unrealisedPnl: "0" },
            { symbol: "ETHUSDT", side: "Buy", size: "1", avgPrice: "3800", unrealisedPnl: "0" },
          ],
        },
      },
    };
    const out = parseBybitAccount(raw);
    expect(out.positions).toHaveLength(1);
    expect(out.positions[0].symbol).toBe("ETHUSDT");
    expect(out.positions[0].qty).toBe(1);
  });

  it("filters zero-size positions", () => {
    const raw = {
      balance: { retCode: 0, result: { list: [{ totalEquity: "0" }] } },
      positions: {
        retCode: 0,
        result: {
          list: [
            { symbol: "BTCUSDT", side: "", size: "0", avgPrice: "0", unrealisedPnl: "0" },
            { symbol: "ETHUSDT", side: "Sell", size: "1", avgPrice: "3800", unrealisedPnl: "-2" },
          ],
        },
      },
    };
    const out = parseBybitAccount(raw);
    expect(out.positions).toHaveLength(1);
    expect(out.positions[0].symbol).toBe("ETHUSDT");
    expect(out.positions[0].qty).toBe(-1);
  });

  it("does not throw on missing/null input", () => {
    expect(() => parseBybitAccount({})).not.toThrow();
    expect(() => parseBybitAccount(null)).not.toThrow();
    const out = parseBybitAccount({});
    expect(out.venue).toBe("bybit");
    expect(out.equity_usd).toBe(0);
    expect(out.positions).toEqual([]);
  });
});

describe("parseHyperliquidAccount", () => {
  it("parses clearinghouseState single payload", () => {
    const raw = {
      marginSummary: {
        accountValue: "10000.0",
        totalMarginUsed: "1500.0",
        totalNtlPos: "20000.0",
      },
      withdrawable: "8500.0",
      assetPositions: [
        {
          type: "oneWay",
          position: {
            coin: "BTC",
            szi: "0.002",
            entryPx: "67120.5",
            positionValue: "134.4",
            unrealizedPnl: "1.23",
          },
        },
        {
          type: "oneWay",
          position: {
            coin: "ETH",
            szi: "-0.5",
            entryPx: "3800.0",
            positionValue: "1900.0",
            unrealizedPnl: "-2.5",
          },
        },
      ],
      time: 1717180800000,
    };
    const out = parseHyperliquidAccount(raw);
    expect(out.venue).toBe("hyperliquid_main");
    expect(out.equity_usd).toBe(10000.0);
    expect(out.free_margin_usd).toBe(8500.0);
    expect(out.positions).toHaveLength(2);
    expect(out.positions[0]).toMatchObject({
      symbol: "BTC",
      qty: 0.002,
      entry_price: 67120.5,
      unrealized_pnl: 1.23,
    });
    // No mark price on clearinghouseState.
    expect(out.positions[0].mark_price).toBeUndefined();
    expect(out.positions[1].qty).toBe(-0.5); // short via signed szi
    expect(out.updated_at).toMatch(/^2024-/);
  });

  it("filters zero-szi positions", () => {
    const raw = {
      marginSummary: { accountValue: "100" },
      withdrawable: "90",
      assetPositions: [
        { position: { coin: "BTC", szi: "0", entryPx: "0", unrealizedPnl: "0" } },
        { position: { coin: "ETH", szi: "1", entryPx: "3800", unrealizedPnl: "0" } },
      ],
    };
    const out = parseHyperliquidAccount(raw);
    expect(out.positions).toHaveLength(1);
    expect(out.positions[0].symbol).toBe("ETH");
  });

  it("does not throw on missing/null input", () => {
    expect(() => parseHyperliquidAccount({})).not.toThrow();
    expect(() => parseHyperliquidAccount(null)).not.toThrow();
    const out = parseHyperliquidAccount({});
    expect(out.venue).toBe("hyperliquid_main");
    expect(out.equity_usd).toBe(0);
    expect(out.free_margin_usd).toBe(0);
    expect(out.positions).toEqual([]);
    // No time → epoch sentinel.
    expect(out.updated_at).toBe(new Date(0).toISOString());
  });
});
