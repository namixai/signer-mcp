/**
 * Unit tests for signer-mcp tool handlers.
 *
 * All tests use a stub fetch (no real network). They exercise:
 *   - happy paths (valid response → toolJson with parsed body)
 *   - auth required but missing (clear error message)
 *   - gateway non-2xx (GatewayError surfaced)
 *   - input validation (place_order limit without price)
 *   - request shape (headers, body, method)
 */

import { describe, expect, it, vi } from "vitest";

import {
  GatewayError,
  STATIC_VENUES,
  callGateway,
  handleCancelOrder,
  handleGetAccount,
  handleGetAttestation,
  handleListVenues,
  handlePlaceOrder,
} from "../src/lib.js";
import { getAccountParser } from "../src/parsers/index.js";

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

/**
 * Route-aware mock fetch — returns different bodies per URL prefix match.
 * Use for tests that exercise the 2-step Option-A flow (gateway → venue).
 *
 * Order matters: longer URL prefixes first. Default to 500 if no match.
 */
function routedMockFetch(routes: Array<{ urlIncludes: string; body: unknown; status?: number }>): typeof fetch {
  return vi.fn().mockImplementation(async (url: string) => {
    const route = routes.find((r) => url.includes(r.urlIncludes));
    if (!route) {
      return {
        ok: false,
        status: 500,
        text: async () => `[test] no route for ${url}`,
      };
    }
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (route.body === undefined ? "" : JSON.stringify(route.body)),
    };
  }) as unknown as typeof fetch;
}

function jsonBodyOf(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

describe("list_venues", () => {
  it("returns static manifest with count", async () => {
    const res = await handleListVenues();
    const body = jsonBodyOf(res);
    expect(body.count).toBe(STATIC_VENUES.length);
    expect(body.venues.map((v: any) => v.venue)).toEqual([
      "binance",
      "okx",
      "asterdex",
    ]);
    expect(body.venues[0].auth_scheme).toBe("hmac_sha256");
  });

  it("does not require gateway or token", async () => {
    // No cfg passed at all — proves no network/auth dep.
    const res = await handleListVenues();
    expect(res.isError).toBeUndefined();
  });
});

describe("get_attestation", () => {
  it("returns parsed JSON on 200", async () => {
    const cfg = {
      gatewayUrl: "https://signer.test",
      fetchImpl: mockFetch({ pcr0: "abc123", issued_at: "2026-05-31T18:00:00Z" }),
    };
    const res = await handleGetAttestation(cfg);
    const body = jsonBodyOf(res);
    expect(body.pcr0).toBe("abc123");
  });

  it("surfaces hint on gateway error", async () => {
    const cfg = {
      gatewayUrl: "https://signer.test",
      fetchImpl: mockFetch(undefined, { status: 500, bodyAsText: "boom" }),
    };
    const res = await handleGetAttestation(cfg);
    expect(res.isError).toBe(true);
    const body = jsonBodyOf(res);
    expect(body.error).toContain("gateway /attestation failed (500)");
    expect(body.hint).toContain("list_venues still works");
  });
});

describe("get_account (Option-A 2-step flow)", () => {
  it("rejects missing token with actionable message", async () => {
    const cfg = {
      gatewayUrl: "https://signer.test",
      fetchImpl: mockFetch({}),
    };
    const res = await handleGetAccount(cfg, { venue: "binance" }, getAccountParser);
    expect(res.isError).toBe(true);
    const body = jsonBodyOf(res);
    expect(body.error).toContain("SIGNER_API_TOKEN is required");
    expect(body.error).toContain("/account/binance");
  });

  it("rejects unknown venue with actionable hint", async () => {
    const cfg = {
      gatewayUrl: "https://signer.test",
      apiToken: "tok",
      fetchImpl: mockFetch({}),
    };
    const res = await handleGetAccount(cfg, { venue: "unknown" }, getAccountParser);
    expect(res.isError).toBe(true);
    const body = jsonBodyOf(res);
    expect(body.error).toContain("No account parser");
    expect(body.hint).toContain("list_venues");
  });

  it("binance: gateway-signed-request → venue submit → parser normalization", async () => {
    const fetchSpy = routedMockFetch([
      // Step 1: gateway returns a signed request for binance
      {
        urlIncludes: "signer.test/account/binance",
        body: {
          venue: "binance",
          method: "GET",
          url: "https://fapi.binance.com/fapi/v2/account?timestamp=...&signature=...",
          headers: { "X-MBX-APIKEY": "real-key" },
        },
      },
      // Step 2: venue returns the raw Binance account payload
      {
        urlIncludes: "fapi.binance.com/fapi/v2/account",
        body: {
          totalMarginBalance: "10000.00",
          availableBalance: "8500.50",
          updateTime: 1717180800000,
          positions: [
            { symbol: "BTCUSDT", positionAmt: "0.002", entryPrice: "67120.5", unrealizedProfit: "1.23" },
          ],
        },
      },
    ]);
    const cfg = {
      gatewayUrl: "https://signer.test",
      apiToken: "sk_test_abc",
      fetchImpl: fetchSpy,
    };
    const res = await handleGetAccount(cfg, { venue: "binance" }, getAccountParser);
    expect(res.isError).toBeUndefined();
    const body = jsonBodyOf(res);
    expect(body.venue).toBe("binance");
    expect(body.equity_usd).toBe(10000);
    expect(body.free_margin_usd).toBe(8500.5);
    expect(body.positions).toHaveLength(1);
    // Verify it called BOTH endpoints — gateway then venue
    expect((fetchSpy as any).mock.calls.length).toBe(2);
    expect((fetchSpy as any).mock.calls[0][0]).toContain("signer.test/account/binance");
    expect((fetchSpy as any).mock.calls[1][0]).toContain("fapi.binance.com");
  });

  it("okx: composite balance+positions bundle → 3 fetches (gateway + 2 venue)", async () => {
    const fetchSpy = routedMockFetch([
      // Step 1: gateway returns composite signed-request bundle
      {
        urlIncludes: "signer.test/account/okx",
        body: {
          venue: "okx",
          balance: {
            venue: "okx",
            method: "GET",
            url: "https://www.okx.com/api/v5/account/balance",
            headers: { "OK-ACCESS-KEY": "k" },
          },
          positions: {
            venue: "okx",
            method: "GET",
            url: "https://www.okx.com/api/v5/account/positions",
            headers: { "OK-ACCESS-KEY": "k" },
          },
        },
      },
      {
        urlIncludes: "/account/balance",
        body: {
          code: "0",
          data: [{ totalEq: "10000", adjEq: "8500", details: [{ ccy: "USDT", availBal: "8000" }] }],
        },
      },
      {
        urlIncludes: "/account/positions",
        body: { code: "0", data: [{ instId: "BTC-USDT-SWAP", pos: "0.002", avgPx: "67120.5", upl: "1.23" }] },
      },
    ]);
    const cfg = {
      gatewayUrl: "https://signer.test",
      apiToken: "sk_test_abc",
      fetchImpl: fetchSpy,
    };
    const res = await handleGetAccount(cfg, { venue: "okx" }, getAccountParser);
    expect(res.isError).toBeUndefined();
    const body = jsonBodyOf(res);
    expect(body.venue).toBe("okx");
    expect(body.equity_usd).toBe(10000);
    expect(body.free_margin_usd).toBe(8000);
    expect(body.positions[0].symbol).toBe("BTC-USDT-SWAP");
    expect((fetchSpy as any).mock.calls.length).toBe(3);
  });

  it("surfaces gateway error before attempting venue fetch", async () => {
    const fetchSpy = routedMockFetch([
      { urlIncludes: "signer.test", body: undefined, status: 503 },
    ]);
    const cfg = {
      gatewayUrl: "https://signer.test",
      apiToken: "tok",
      fetchImpl: fetchSpy,
    };
    const res = await handleGetAccount(cfg, { venue: "binance" }, getAccountParser);
    expect(res.isError).toBe(true);
    const body = jsonBodyOf(res);
    expect(body.error).toContain("503");
    // Only one fetch — gateway. Venue never reached.
    expect((fetchSpy as any).mock.calls.length).toBe(1);
  });

  it("asterdex: gateway returns parsed indexer payload directly (no signed-request shape)", async () => {
    const fetchSpy = routedMockFetch([
      {
        urlIncludes: "signer.test/account/asterdex",
        body: {
          wallet: "0xabc",
          equity_usd: "5000",
          available_margin_usd: "4500",
          positions: [{ market: "BTC-USD", size: "0.001", entry_price: "67000", unrealized_pnl_usd: "0.2" }],
          block_timestamp: 1717180800,
        },
      },
    ]);
    const cfg = {
      gatewayUrl: "https://signer.test",
      apiToken: "tok",
      fetchImpl: fetchSpy,
    };
    const res = await handleGetAccount(cfg, { venue: "asterdex" }, getAccountParser);
    expect(res.isError).toBeUndefined();
    const body = jsonBodyOf(res);
    expect(body.venue).toBe("asterdex");
    expect(body.equity_usd).toBe(5000);
    expect(body.positions[0].symbol).toBe("BTC-USD");
    // Only one fetch — gateway, no signed-request submission needed.
    expect((fetchSpy as any).mock.calls.length).toBe(1);
  });
});

describe("place_order", () => {
  it("rejects type=limit without price BEFORE calling gateway", async () => {
    const fetchSpy = mockFetch({});
    const cfg = {
      gatewayUrl: "https://signer.test",
      apiToken: "tok",
      fetchImpl: fetchSpy,
    };
    const res = await handlePlaceOrder(cfg, {
      venue: "binance",
      symbol: "BTCUSDT",
      side: "buy",
      qty: 0.001,
      type: "limit",
    });
    expect(res.isError).toBe(true);
    const body = jsonBodyOf(res);
    expect(body.error).toContain("price is required when type=limit");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("market order with price set is passed through (no client-side rejection)", async () => {
    const fetchSpy = mockFetch({ order_id: "abc" });
    const cfg = {
      gatewayUrl: "https://signer.test",
      apiToken: "tok",
      fetchImpl: fetchSpy,
    };
    const res = await handlePlaceOrder(cfg, {
      venue: "binance",
      symbol: "BTCUSDT",
      side: "buy",
      qty: 0.001,
      type: "market",
      price: 67000,
    });
    expect(res.isError).toBeUndefined();
    const call = (fetchSpy as any).mock.calls[0];
    expect(call[1].method).toBe("POST");
    const sentBody = JSON.parse(call[1].body);
    expect(sentBody.price).toBe(67000);
  });

  it("auth required — fails fast without token", async () => {
    const cfg = {
      gatewayUrl: "https://signer.test",
      fetchImpl: mockFetch({}),
    };
    const res = await handlePlaceOrder(cfg, {
      venue: "binance",
      symbol: "BTCUSDT",
      side: "buy",
      qty: 0.001,
      type: "market",
    });
    expect(res.isError).toBe(true);
    expect(jsonBodyOf(res).error).toContain("SIGNER_API_TOKEN is required");
  });

  it("POSTs to /sign/<venue>-order with full body (per-venue endpoint pattern)", async () => {
    const fetchSpy = mockFetch({ order_id: "binance_42", status: "FILLED" });
    const cfg = {
      gatewayUrl: "https://signer.test",
      apiToken: "tok",
      fetchImpl: fetchSpy,
    };
    const res = await handlePlaceOrder(cfg, {
      venue: "binance",
      symbol: "BTCUSDT",
      side: "buy",
      qty: 0.001,
      type: "market",
      policy_id: "custom-policy",
    });
    expect(res.isError).toBeUndefined();
    const call = (fetchSpy as any).mock.calls[0];
    // CTO 2026-05-31T2240 decision: per-venue endpoints
    expect(call[0]).toBe("https://signer.test/sign/binance-order");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(call[1].body);
    expect(body).toMatchObject({
      venue: "binance",
      symbol: "BTCUSDT",
      side: "buy",
      qty: 0.001,
      type: "market",
      policy_id: "custom-policy",
    });
  });

  it("surfaces gateway 4xx as toolError without crashing", async () => {
    const cfg = {
      gatewayUrl: "https://signer.test",
      apiToken: "tok",
      fetchImpl: mockFetch(undefined, {
        status: 422,
        bodyAsText: '{"code":"POLICY_CAP_EXCEEDED"}',
      }),
    };
    const res = await handlePlaceOrder(cfg, {
      venue: "binance",
      symbol: "BTCUSDT",
      side: "buy",
      qty: 999,
      type: "market",
    });
    expect(res.isError).toBe(true);
    expect(jsonBodyOf(res).error).toContain("422");
    expect(jsonBodyOf(res).error).toContain("POLICY_CAP_EXCEEDED");
  });
});

describe("cancel_order", () => {
  it("POSTs to /sign/<venue>-cancel with venue + order_id (per-venue pattern)", async () => {
    const fetchSpy = mockFetch({ ok: true, residual_qty: 0 });
    const cfg = {
      gatewayUrl: "https://signer.test",
      apiToken: "tok",
      fetchImpl: fetchSpy,
    };
    const res = await handleCancelOrder(cfg, {
      venue: "okx",
      order_id: "OKX-123",
      symbol: "BTC-USDT",
    });
    expect(res.isError).toBeUndefined();
    const call = (fetchSpy as any).mock.calls[0];
    expect(call[0]).toBe("https://signer.test/sign/okx-cancel");
    expect(JSON.parse(call[1].body)).toEqual({
      venue: "okx",
      order_id: "OKX-123",
      symbol: "BTC-USDT",
    });
  });

  it("rejects binance/okx cancel without symbol BEFORE calling gateway", async () => {
    const fetchSpy = mockFetch({});
    const cfg = {
      gatewayUrl: "https://signer.test",
      apiToken: "tok",
      fetchImpl: fetchSpy,
    };
    for (const venue of ["binance", "okx"]) {
      const res = await handleCancelOrder(cfg, { venue, order_id: "X" });
      expect(res.isError).toBe(true);
      expect(jsonBodyOf(res).error).toContain('requires "symbol"');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("handles empty 200 OK gracefully (some venues return no body)", async () => {
    // Under Option-A, both gateway AND venue can return empty bodies.
    // Mock: gateway returns a SignedRequest, venue returns empty 200.
    const fetchSpy = routedMockFetch([
      {
        urlIncludes: "signer.test/sign/binance-cancel",
        body: {
          venue: "binance",
          method: "DELETE",
          url: "https://fapi.binance.com/fapi/v1/order?orderId=X",
          headers: { "X-MBX-APIKEY": "k" },
        },
      },
      { urlIncludes: "fapi.binance.com", body: undefined, status: 200 },
    ]);
    const cfg = {
      gatewayUrl: "https://signer.test",
      apiToken: "tok",
      fetchImpl: fetchSpy,
    };
    const res = await handleCancelOrder(cfg, {
      venue: "binance",
      order_id: "X",
      symbol: "BTCUSDT",
    });
    expect(res.isError).toBeUndefined();
    const body = jsonBodyOf(res);
    // submitSignedRequest returns null on empty body; toolJson wraps { venue, response: null }
    expect(body.venue).toBe("binance");
    expect(body.response).toBeNull();
  });
});

describe("callGateway (direct)", () => {
  it("includes UA header with package version", async () => {
    const fetchSpy = mockFetch({});
    await callGateway(
      "/test",
      {},
      { gatewayUrl: "https://signer.test", fetchImpl: fetchSpy },
    );
    const headers = (fetchSpy as any).mock.calls[0][1].headers;
    expect(headers["User-Agent"]).toMatch(/^@usenami\/signer-mcp@/);
  });

  it("GatewayError has structured status + body + endpoint", async () => {
    const cfg = {
      gatewayUrl: "https://signer.test",
      fetchImpl: mockFetch(undefined, { status: 404, bodyAsText: "not found" }),
    };
    try {
      await callGateway("/missing", {}, cfg);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      const ge = e as GatewayError;
      expect(ge.status).toBe(404);
      expect(ge.body).toBe("not found");
      expect(ge.endpoint).toBe("/missing");
    }
  });
});
