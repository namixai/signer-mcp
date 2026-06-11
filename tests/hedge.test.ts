/**
 * place_hedge — atomic 2-leg hedge via gateway /hedge.
 *
 * Pins: wire body shape (2 legs, venue-NATIVE symbol + size after the
 * canonical translation layer), pre-gateway validation, per-leg translation
 * echo, and the loud PARTIAL (naked position) warning.
 */
import { describe, expect, it, vi } from "vitest";

import { handlePlaceHedge } from "../src/lib.js";

function mockFetch(
  body: unknown,
  init: { status?: number; bodyAsText?: string } = {},
): typeof fetch {
  const status = init.status ?? 200;
  const text =
    init.bodyAsText !== undefined
      ? init.bodyAsText
      : body === undefined
        ? ""
        : JSON.stringify(body);
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  }) as unknown as typeof fetch;
}

function jsonBodyOf(res: { content: Array<{ text: string }> }) {
  return JSON.parse(res.content[0].text);
}

const CFG = (fetchImpl: typeof fetch) => ({
  gatewayUrl: "https://signer.test",
  apiToken: "tok",
  fetchImpl,
});

const BTC_HEDGE = {
  legs: [
    { venue: "binance", symbol: "BTC", side: "buy" as const, qty: 0.01, type: "market" as const },
    { venue: "okx", symbol: "BTC", side: "sell" as const, qty: 0.01, type: "market" as const },
  ],
};

describe("place_hedge", () => {
  it("POSTs /hedge with venue-native symbol AND size per leg", async () => {
    const fetchSpy = mockFetch({ status: "executed", legs: [], sign_ms: 12 });
    const res = await handlePlaceHedge(CFG(fetchSpy), BTC_HEDGE);
    expect(res.isError).toBeUndefined();
    const call = (fetchSpy as any).mock.calls[0];
    expect(call[0]).toBe("https://signer.test/hedge");
    expect(call[1].method).toBe("POST");
    const body = JSON.parse(call[1].body);
    // The 100×-bug class must not reappear here: okx leg is in CONTRACTS.
    expect(body).toEqual({
      legs: [
        {
          key_id: "binance",
          order: {
            symbol: "BTCUSDT",
            side: "buy",
            qty: "0.01",
            ord_type: "market",
            reduce_only: false,
          },
        },
        {
          key_id: "okx",
          order: {
            symbol: "BTC-USDT-SWAP",
            side: "sell",
            qty: "1",
            ord_type: "market",
            reduce_only: false,
          },
        },
      ],
    });
  });

  it("echoes per-leg translations in the result", async () => {
    const fetchSpy = mockFetch({ status: "executed", legs: [], sign_ms: 12 });
    const res = await handlePlaceHedge(CFG(fetchSpy), BTC_HEDGE);
    const out = jsonBodyOf(res);
    expect(out.translations).toHaveLength(2);
    expect(out.translations[0].sent).toMatchObject({ symbol: "BTCUSDT", unit: "base" });
    expect(out.translations[1].sent).toMatchObject({
      symbol: "BTC-USDT-SWAP",
      qty: "1",
      unit: "contracts",
      ctVal: "0.01",
    });
  });

  it("rejects leg counts other than 2 BEFORE calling the gateway", async () => {
    const fetchSpy = mockFetch({});
    const res = await handlePlaceHedge(CFG(fetchSpy), {
      legs: [BTC_HEDGE.legs[0]],
    });
    expect(res.isError).toBe(true);
    expect(jsonBodyOf(res).error).toContain("exactly 2 legs");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unsupported venues + limit-without-price BEFORE the gateway", async () => {
    const fetchSpy = mockFetch({});
    const badVenue = await handlePlaceHedge(CFG(fetchSpy), {
      legs: [
        { ...BTC_HEDGE.legs[0], venue: "kucoin" },
        BTC_HEDGE.legs[1],
      ],
    });
    expect(badVenue.isError).toBe(true);
    expect(jsonBodyOf(badVenue).error).toContain("leg 1");
    const noPrice = await handlePlaceHedge(CFG(fetchSpy), {
      legs: [
        { ...BTC_HEDGE.legs[0], type: "limit" as const },
        BTC_HEDGE.legs[1],
      ],
    });
    expect(noPrice.isError).toBe(true);
    expect(jsonBodyOf(noPrice).error).toContain("price is required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces normalization failures with the leg index", async () => {
    const fetchSpy = mockFetch({});
    const res = await handlePlaceHedge(CFG(fetchSpy), {
      legs: [
        BTC_HEDGE.legs[0],
        { ...BTC_HEDGE.legs[1], qty: 0.012345 }, // off the okx contract grid
      ],
    });
    expect(res.isError).toBe(true);
    expect(jsonBodyOf(res).error).toContain("leg 2 (okx)");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("makes a PARTIAL hedge impossible to miss", async () => {
    const fetchSpy = mockFetch({
      status: "partial",
      legs: [
        { venue: "binance", ok: true },
        { venue: "okx", ok: false },
      ],
      sign_ms: 10,
      exec_ms: 400,
    });
    const res = await handlePlaceHedge(CFG(fetchSpy), BTC_HEDGE);
    expect(res.isError).toBeUndefined();
    const out = jsonBodyOf(res);
    expect(out.status).toBe("partial");
    expect(out.warning).toContain("NAKED");
  });

  it("maps a 404 (old gateway) to a clear upgrade hint", async () => {
    const fetchSpy = mockFetch(undefined, { status: 404, bodyAsText: "not found" });
    const res = await handlePlaceHedge(CFG(fetchSpy), BTC_HEDGE);
    expect(res.isError).toBe(true);
    expect(jsonBodyOf(res).hint).toContain("two place_order calls");
  });

  it("propagates policy_denied (403) from the sign phase", async () => {
    const fetchSpy = mockFetch(undefined, {
      status: 403,
      bodyAsText: JSON.stringify({ status: "rejected", legs: [] }),
    });
    const res = await handlePlaceHedge(CFG(fetchSpy), BTC_HEDGE);
    expect(res.isError).toBe(true);
    expect(jsonBodyOf(res).error).toContain("403");
  });
});
