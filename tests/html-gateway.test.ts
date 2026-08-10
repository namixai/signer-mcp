/**
 * The 0.5.x default gateway URL pointed at a website that 301-redirected every
 * path to an HTML landing page; bare JSON.parse then leaked
 * "Unexpected token '<'" to the user, which reads as a broken install rather
 * than a wrong URL. Pin: an HTML response is named as such, with the env var
 * to check — and the raw parser error never surfaces.
 */
import { describe, expect, it, vi } from "vitest";

import { callGateway } from "../src/lib.js";

function fetchReturning(text: string, init: { status?: number; contentType?: string } = {}) {
  const status = init.status ?? 200;
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: init.contentType
      ? { get: (k: string) => (k.toLowerCase() === "content-type" ? init.contentType : null) }
      : undefined,
    text: async () => text,
  }) as unknown as typeof fetch;
}

const CFG = (fetchImpl: typeof fetch) => ({
  gatewayUrl: "https://gateway.test",
  apiToken: "",
  fetchImpl,
});

describe("callGateway HTML detection", () => {
  it("names an HTML body instead of leaking the JSON parser error", async () => {
    const fetchImpl = fetchReturning("<!DOCTYPE html><html><body>landing</body></html>");
    await expect(callGateway("/attestation", {}, CFG(fetchImpl))).rejects.toThrow(
      /returned HTML, not JSON.*SIGNER_GATEWAY_URL/s,
    );
    await expect(callGateway("/attestation", {}, CFG(fetchImpl))).rejects.not.toThrow(
      /Unexpected token/,
    );
  });

  it("detects HTML via content-type even without a leading '<'", async () => {
    const fetchImpl = fetchReturning("\n\nlanding page…", { contentType: "text/html; charset=utf-8" });
    await expect(callGateway("/attestation", {}, CFG(fetchImpl))).rejects.toThrow(
      /returned HTML, not JSON/,
    );
  });

  it("weakened guard control: valid JSON still parses", async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ ok: 1 }));
    await expect(callGateway("/attestation", {}, CFG(fetchImpl))).resolves.toEqual({ ok: 1 });
  });
});
