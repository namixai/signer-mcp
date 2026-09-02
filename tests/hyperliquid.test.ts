/**
 * Hyperliquid order route.
 *
 * The tests that matter here are not the happy path — they are the ones that
 * lock behaviour where a mistake costs money rather than a 400:
 *
 *   · the asset index must come from the venue's own list, and an unknown coin
 *     must fail closed. A wrong index is a real order on a different market,
 *     signed and authentic.
 *   · the action submitted must be the SAME OBJECT that was sent for signing.
 *     If they diverge, the signature is valid — for something else.
 *   · "market" must be refused rather than synthesised, because synthesising it
 *     means choosing a slippage bound on someone else's money.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import { handleCancelOrder, handlePlaceOrder } from "../src/lib.js";
import {
  buildOrderAction,
  formatPrice,
  formatSize,
  parseOid,
  resetUniverseCacheForTests,
  resolveAsset,
} from "../src/hyperliquid.js";

const UNIVERSE = {
  universe: [
    { name: "BTC", szDecimals: 5 },
    { name: "ETH", szDecimals: 4 },
    { name: "SOL", szDecimals: 2 },
  ],
};

/**
 * Records every call, and lets a test choose what the VENUE answers.
 *
 * 🔴 The `exchange` override exists because the earlier stub always answered
 * `{status:"ok"}` — which made every transport test green no matter what the
 * transport did. A stub that cannot produce a refusal cannot catch one being
 * mistaken for a success, and that is exactly the bug it was covering.
 */
function stubFetch(overrides: { sign?: unknown; exchange?: unknown } = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, body });
    let payload: unknown = { ok: true };
    if (u.endsWith("/info")) payload = UNIVERSE;
    else if (u.endsWith("/sign")) {
      payload = overrides.sign ?? { signature: { r: "0x1", s: "0x2", v: 28 }, receipt: { seq: "7" } };
    } else if (u.endsWith("/exchange")) {
      // Real success shape, not a placeholder: an accepted order rests with an oid.
      payload =
        overrides.exchange ??
        { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 77 } }] } } };
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

/** Tool results carry JSON as text; parse it rather than regex the escaping. */
function payload(res: { content: { type: string; text: string }[] }): any {
  return JSON.parse(res.content[0].text);
}

const cfg = (fetchImpl: typeof fetch) => ({
  gatewayUrl: "https://signer.example",
  apiToken: "t",
  fetchImpl,
});

beforeEach(() => resetUniverseCacheForTests());

describe("asset index", () => {
  it("comes from the venue's own list, by name and not by position", async () => {
    const { impl } = stubFetch();
    const eth = await resolveAsset("hyperliquid_main", "eth", impl);
    expect(eth).toMatchObject({ index: 1, name: "ETH", szDecimals: 4 });
  });

  it("fails closed on a coin the venue does not list", async () => {
    const { impl } = stubFetch();
    await expect(resolveAsset("hyperliquid_main", "NOTACOIN", impl)).rejects.toThrow(
      /not a Hyperliquid perp/,
    );
  });

  it("keeps mainnet and testnet universes apart", async () => {
    const { impl, calls } = stubFetch();
    await resolveAsset("hyperliquid_main", "BTC", impl);
    await resolveAsset("hyperliquid_testnet", "BTC", impl);
    const hosts = calls.filter((c) => c.url.endsWith("/info")).map((c) => c.url);
    expect(hosts).toEqual([
      "https://api.hyperliquid.xyz/info",
      "https://api.hyperliquid-testnet.xyz/info",
    ]);
  });
});

describe("size and price formatting", () => {
  it("rounds size to the asset's own precision", () => {
    expect(formatSize(0.123456789, 5)).toBe("0.12346");
    expect(formatSize(1, 5)).toBe("1");
  });

  it("refuses a size that rounds to zero rather than sending a zero order", () => {
    expect(() => formatSize(0.0000001, 5)).toThrow(/rounds to zero/);
  });

  it("holds prices to five significant figures and the per-asset decimal cap", () => {
    // szDecimals 5 → at most 1 decimal place, and 5 sig figs.
    expect(formatPrice(123456.789, 5)).toBe("123460");
    expect(formatPrice(1234.5678, 5)).toBe("1234.6");
  });

  it("exempts integers from the significant-figure rule, as the venue does", () => {
    expect(formatPrice(123456, 5)).toBe("123456");
  });
});

describe("order id", () => {
  it("refuses anything that is not a positive integer oid", () => {
    expect(() => parseOid("abc")).toThrow(/positive integer/);
    expect(() => parseOid("1.5")).toThrow(/positive integer/);
    expect(parseOid("42")).toBe(42);
  });

  it("🔴 refuses an oid that would silently become a DIFFERENT order", () => {
    // Number("9007199254740993") === 9007199254740992, and Number.isInteger is
    // true of the result — the guard has to run before the damage, not after.
    expect(() => parseOid("9007199254740993")).toThrow(/different order/);
    // the largest value that survives is still accepted
    expect(parseOid("9007199254740991")).toBe(9007199254740991);
  });
});

describe("place_order on Hyperliquid", () => {
  it("🔴 submits EXACTLY the action it sent for signing", async () => {
    const { impl, calls } = stubFetch();
    const res = await handlePlaceOrder(cfg(impl), {
      venue: "hyperliquid_main",
      symbol: "BTC",
      side: "buy",
      qty: 0.01,
      type: "limit",
      price: 65000,
    });
    expect(res.isError).toBeFalsy();
    const signCall = calls.find((c) => c.url.endsWith("/sign"))!;
    const submitCall = calls.find((c) => c.url.endsWith("/exchange"))!;
    const signBody = signCall.body as Record<string, any>;
    const submitBody = submitCall.body as Record<string, any>;

    // The whole point: one object, signed and then submitted unchanged.
    expect(submitBody.action).toEqual(signBody.action);
    expect(submitBody.nonce).toBe(signBody.nonce);
    expect(signBody.exchange).toBe("hyperliquid_main");
    expect(signBody.kind).toBe("order");
    // …and it is addressed by the index we resolved, not by a symbol.
    expect(signBody.action.orders[0].a).toBe(0);
    expect(signBody.action.orders[0].b).toBe(true);
  });

  it("🔴 refuses a market order instead of choosing a slippage bound", async () => {
    const { impl, calls } = stubFetch();
    const res = await handlePlaceOrder(cfg(impl), {
      venue: "hyperliquid_main",
      symbol: "BTC",
      side: "buy",
      qty: 0.01,
      type: "market",
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/no market order type/);
    // and nothing was signed or sent
    expect(calls.filter((c) => c.url.endsWith("/sign"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.endsWith("/exchange"))).toHaveLength(0);
  });

  it("does not submit anything when the gateway refuses to sign", async () => {
    const { impl, calls } = stubFetch({ sign: { receipt: { seq: "7" } } });
    const res = await handlePlaceOrder(cfg(impl), {
      venue: "hyperliquid_main",
      symbol: "BTC",
      side: "sell",
      qty: 0.01,
      type: "limit",
      price: 65000,
    });
    expect(res.isError).toBe(true);
    expect(calls.filter((c) => c.url.endsWith("/exchange"))).toHaveLength(0);
  });

  it("carries the decision receipt back to the caller", async () => {
    const { impl } = stubFetch();
    const res = await handlePlaceOrder(cfg(impl), {
      venue: "hyperliquid_main",
      symbol: "BTC",
      side: "buy",
      qty: 0.01,
      type: "limit",
      price: 65000,
    });
    expect(payload(res as any).receipt).toEqual({ seq: "7" });
  });
});

describe("🔴 the venue refuses inside HTTP 200", () => {
  // Verified against the live endpoint 2026-09-02: an unsigned cancel returns
  // HTTP 200 with {"status":"err", …}. Reading res.ok as acceptance would tell
  // the caller its order is live when the exchange refused it.
  it("treats a top-level err as a refusal, not a success", async () => {
    const { impl } = stubFetch({
      exchange: { status: "err", response: "User or API Wallet 0x… does not exist." },
    });
    const res = await handlePlaceOrder(cfg(impl), {
      venue: "hyperliquid_main",
      symbol: "BTC",
      side: "buy",
      qty: 0.01,
      type: "limit",
      price: 65000,
    });
    expect(res.isError).toBe(true);
    expect(payload(res as any).error).toMatch(/refused the action/);
  });

  it("catches a per-order error even when the action itself was accepted", async () => {
    const { impl } = stubFetch({
      exchange: {
        status: "ok",
        response: { type: "order", data: { statuses: [{ error: "Order price cannot be more than 80% away from the reference price" }] } },
      },
    });
    const res = await handlePlaceOrder(cfg(impl), {
      venue: "hyperliquid_main",
      symbol: "BTC",
      side: "buy",
      qty: 0.01,
      type: "limit",
      price: 65000,
    });
    expect(res.isError).toBe(true);
    expect(payload(res as any).error).toMatch(/80% away/);
  });

  it("accepts a genuine success and carries the venue receipt through", async () => {
    const { impl } = stubFetch();
    const res = await handlePlaceOrder(cfg(impl), {
      venue: "hyperliquid_main",
      symbol: "BTC",
      side: "buy",
      qty: 0.01,
      type: "limit",
      price: 65000,
    });
    expect(res.isError).toBeFalsy();
    expect(payload(res as any).response.response.data.statuses[0].resting.oid).toBe(77);
  });

  it("refuses a body it cannot recognise rather than calling it success", async () => {
    const { impl } = stubFetch({ exchange: { totally: "unexpected" } });
    const res = await handlePlaceOrder(cfg(impl), {
      venue: "hyperliquid_main",
      symbol: "BTC",
      side: "sell",
      qty: 0.01,
      type: "limit",
      price: 65000,
    });
    expect(res.isError).toBe(true);
  });
});

describe("testnet is actually usable", () => {
  // It was not: every symbol threw "no symbol mapping for venue" because the
  // translator table had no testnet row, while the route advertised testnet as
  // the free place to rehearse a mainnet order.
  it("translates symbols and reaches the testnet host", async () => {
    const { impl, calls } = stubFetch();
    const res = await handlePlaceOrder(cfg(impl), {
      venue: "hyperliquid_testnet",
      symbol: "BTCUSDT",
      side: "buy",
      qty: 0.01,
      type: "limit",
      price: 65000,
    });
    expect(res.isError).toBeFalsy();
    expect(calls.some((c) => c.url === "https://api.hyperliquid-testnet.xyz/exchange")).toBe(true);
    expect(calls.every((c) => !c.url.startsWith("https://api.hyperliquid.xyz"))).toBe(true);
  });
});

describe("cancel_order on Hyperliquid", () => {
  it("addresses the cancel by asset index and submits what was signed", async () => {
    const { impl, calls } = stubFetch();
    const res = await handleCancelOrder(cfg(impl), {
      venue: "hyperliquid_main",
      symbol: "ETH",
      order_id: "12345",
    });
    expect(res.isError).toBeFalsy();
    const signBody = calls.find((c) => c.url.endsWith("/sign"))!.body as Record<string, any>;
    const submitBody = calls.find((c) => c.url.endsWith("/exchange"))!.body as Record<string, any>;
    expect(signBody.kind).toBe("cancel");
    expect(signBody.action).toEqual({ type: "cancel", cancels: [{ a: 1, o: 12345 }] });
    expect(submitBody.action).toEqual(signBody.action);
  });

  it("requires the symbol, because the index is derived from it", async () => {
    const { impl } = stubFetch();
    const res = await handleCancelOrder(cfg(impl), {
      venue: "hyperliquid_main",
      order_id: "12345",
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/requires .{0,4}symbol/);
  });
});

describe("action shape", () => {
  it("builds the venue's own order shape", () => {
    const action = buildOrderAction({
      asset: { index: 3, name: "SOL", szDecimals: 2 },
      isBuy: false,
      price: "150.5",
      size: "1.25",
      reduceOnly: true,
    });
    expect(action).toEqual({
      type: "order",
      orders: [{ a: 3, b: false, p: "150.5", s: "1.25", r: true, t: { limit: { tif: "Gtc" } } }],
      grouping: "na",
    });
  });
});
