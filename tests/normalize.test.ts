/**
 * Venue normalization layer — canonical symbol + canonical size.
 *
 * Covers the CRITICAL 2026-06-11 bug class: OKX sizes orders in CONTRACTS
 * (1 ct = 0.01 BTC on BTC-USDT-SWAP); passing base-asset qty through raw
 * silently produced a 100× undersized leg. These tests pin the canonical→
 * native mapping for symbol AND size, and the fail-closed behavior for
 * anything we cannot translate exactly.
 */
import { describe, expect, it } from "vitest";

import {
  NormalizationError,
  OKX_SWAP_SPECS,
  canonicalBase,
  toNativeQty,
  toNativeSymbol,
  translateOrder,
} from "../src/normalize.js";

describe("canonicalBase", () => {
  it("accepts bare base, canonical pairs, and venue-native spellings", () => {
    for (const input of [
      "BTC",
      "btc",
      "BTCUSDT",
      "BTC/USDT",
      "BTC-USDT",
      "BTC-USDT-SWAP",
      "XBTUSDTM",
      "BTC-USD",
    ]) {
      expect(canonicalBase(input)).toBe("BTC");
    }
  });

  it("maps KuCoin XBT alias to BTC", () => {
    expect(canonicalBase("XBT")).toBe("BTC");
  });

  it("handles non-BTC bases", () => {
    expect(canonicalBase("ETHUSDT")).toBe("ETH");
    expect(canonicalBase("SOL-USDT-SWAP")).toBe("SOL");
    expect(canonicalBase("1000PEPE")).toBe("1000PEPE");
  });

  it("rejects garbage instead of guessing", () => {
    for (const bad of ["", "  ", "BTC/ETH/USDT", "B!TC", "USDT"]) {
      expect(() => canonicalBase(bad)).toThrow(NormalizationError);
    }
  });
});

describe("toNativeSymbol", () => {
  it("builds each venue's native format from any accepted spelling", () => {
    expect(toNativeSymbol("binance", "BTC")).toBe("BTCUSDT");
    expect(toNativeSymbol("binance", "BTC-USDT-SWAP")).toBe("BTCUSDT");
    expect(toNativeSymbol("okx", "BTC")).toBe("BTC-USDT-SWAP");
    expect(toNativeSymbol("okx", "BTCUSDT")).toBe("BTC-USDT-SWAP");
    expect(toNativeSymbol("bybit", "BTC/USDT")).toBe("BTCUSDT");
    expect(toNativeSymbol("kucoin", "BTC")).toBe("XBTUSDTM");
    expect(toNativeSymbol("kucoin", "ETH")).toBe("ETHUSDTM");
    expect(toNativeSymbol("hyperliquid_main", "BTCUSDT")).toBe("BTC");
    expect(toNativeSymbol("asterdex", "BTC")).toBe("BTC-USD");
  });

  it("rejects venues without a mapping instead of inventing a format", () => {
    expect(() => toNativeSymbol("unknown_venue", "BTC")).toThrow(
      NormalizationError,
    );
  });
});

describe("toNativeQty (okx contracts conversion)", () => {
  it("converts base→contracts exactly: 0.01 BTC = 1 contract", () => {
    expect(toNativeQty("okx", "BTC-USDT-SWAP", 0.01)).toEqual({
      nativeQty: "1",
      nativeUnit: "contracts",
      ctVal: "0.01",
    });
  });

  it("THE 100× BUG: 0.01 raw would have been 0.0001 BTC — now it is 1 contract", () => {
    // Old behavior: sz="0.01" → OKX reads 0.01 contracts = 0.0001 BTC.
    // New behavior: 0.01 BTC → sz="1". The raw number NEVER hits the wire.
    const t = toNativeQty("okx", "BTC-USDT-SWAP", 0.01);
    expect(t.nativeQty).not.toBe("0.01");
    expect(t.nativeQty).toBe("1");
  });

  it("supports fractional contracts on the lot grid (lotSz 0.01)", () => {
    // 0.0001 BTC = 0.01 contracts — exactly the venue minimum/lot step.
    expect(toNativeQty("okx", "BTC-USDT-SWAP", 0.0001).nativeQty).toBe("0.01");
    // 0.0123 BTC = 1.23 contracts — clean multiple of 0.01 ct.
    expect(toNativeQty("okx", "BTC-USDT-SWAP", 0.0123).nativeQty).toBe("1.23");
  });

  it("converts per-instrument ctVal: ETH 0.1, SOL 1", () => {
    expect(toNativeQty("okx", "ETH-USDT-SWAP", 1).nativeQty).toBe("10");
    expect(toNativeQty("okx", "SOL-USDT-SWAP", 5).nativeQty).toBe("5");
  });

  it("rejects off-grid sizes with the nearest valid choices, never rounds", () => {
    expect(() => toNativeQty("okx", "BTC-USDT-SWAP", 0.012345)).toThrow(
      /not a clean multiple.*0.0123 or 0.0124/s,
    );
  });

  it("rejects below venue minimum", () => {
    expect(() => toNativeQty("okx", "BTC-USDT-SWAP", 0.00005)).toThrow(
      /not a clean multiple|below the venue minimum/,
    );
  });

  it("rejects instruments not in the pinned table (fail closed)", () => {
    expect(() => toNativeQty("okx", "DOGE-USDT-SWAP", 100)).toThrow(
      /pinned spec table/,
    );
  });

  it("passes binance through in base units", () => {
    expect(toNativeQty("binance", "BTCUSDT", 0.001)).toEqual({
      nativeQty: "0.001",
      nativeUnit: "base",
    });
  });

  it("float artifacts do not poison the conversion (0.1+0.2 class)", () => {
    // 0.30000000000000004 stringifies with the artifact and MUST be rejected
    // (more precision than the grid), not silently accepted as 0.3.
    expect(() => toNativeQty("okx", "BTC-USDT-SWAP", 0.1 + 0.2)).toThrow(
      NormalizationError,
    );
    // A clean 0.3 converts exactly.
    expect(toNativeQty("okx", "BTC-USDT-SWAP", 0.3).nativeQty).toBe("30");
  });
});

describe("translateOrder echo", () => {
  it("echoes requested vs sent with a contracts warning note for okx", () => {
    const { nativeSymbol, nativeQty, echo } = translateOrder("okx", "BTC", 0.01);
    expect(nativeSymbol).toBe("BTC-USDT-SWAP");
    expect(nativeQty).toBe("1");
    expect(echo.requested).toEqual({ symbol: "BTC", qty: 0.01, unit: "base_asset" });
    expect(echo.sent).toEqual({
      symbol: "BTC-USDT-SWAP",
      qty: "1",
      unit: "contracts",
      ctVal: "0.01",
    });
    expect(echo.note).toContain("CONTRACTS");
  });

  it("echoes base-unit venues without a note", () => {
    const { echo } = translateOrder("binance", "BTC", 0.001);
    expect(echo.sent).toEqual({ symbol: "BTCUSDT", qty: "0.001", unit: "base" });
    expect(echo.note).toBeUndefined();
  });
});

describe("pinned specs sanity", () => {
  it("every pinned spec has decimal strings only", () => {
    for (const [instId, spec] of Object.entries(OKX_SWAP_SPECS)) {
      for (const v of [spec.ctVal, spec.lotSz, spec.minSz]) {
        expect(v, `${instId} ${v}`).toMatch(/^\d+(\.\d+)?$/);
      }
    }
  });
});
