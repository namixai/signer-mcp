// Четыре проверки — это и есть весь смысл инструмента.
//
// Инструмент, который отдаёт цену без них, — обычный GraphQL-клиент, только медленнее.
// Поэтому здесь проверяется не «вернулась ли цена», а что КАЖДАЯ проверка умеет
// остановить ответ и что её собственное имя доезжает до агента.
//
// 🔴 Почему имена важны по отдельности. `price_absent_or_zero` — у этого токена нет
// цены, спрашивай другой. `graphql_errors` — запрос отвергнут, чини запрос. `price_stale`
// — рынок мёртв, торговать по этой цене нельзя. Три разные починки. Агент, который видит
// только «не годится», выберет неправильную.

import { describe, it, expect } from "vitest";
import { handleGetVerifiedPrice, type PriceDeps } from "../src/graph-price.js";

const read = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

// Заглушки, при которых проход доходит до конца. Каждый тест ломает РОВНО ОДНУ.
const passingBase = (): PriceDeps =>
  ({
    paidQuery: async () => ({ ok: true, status: 200, rawBody: '{"data":{}}', attestationHeader: "hdr", subgraphId: "sub" }),
    parseAttestationHeader: () => ({ parsed: true }),
    verifyAttestation: async () => ({ ok: true, allocationId: "0xalloc", subgraphDeploymentID: "0xdep" }),
    chainHead: async () => 1000n,
    resolveIndexer: async () => ({ ok: true, indexer: "0xindexer" }),
    arbitrumClient: () => ({}),
    checkUsable: () => ({ ok: true, priceUSD: "1.5", priceBlock: "990", metaBlock: "999", sourceLagBlocks: "1", priceLagBlocks: "10" }),
    buildSnapshot: () => ({ ok: true, snapshot: { reading: { price_usd: "1.5" } }, bytes: 123 }),
  }) as unknown as PriceDeps;

describe("каждая из четырёх проверок останавливает ответ и называет себя", () => {
  it("подпись индексера не сошлась — цены нет", async () => {
    const deps = { ...passingBase(), verifyAttestation: async () => ({ ok: false, reason: "response_cid_mismatch" }) } as unknown as PriceDeps;
    const out = read(await handleGetVerifiedPrice({ symbol: "WETH" }, deps));
    expect(out.ok).toBe(false);
    expect(out.stage).toBe("attestation");
    expect(out.cause).toBe("response_cid_mismatch");
    expect(out.snapshot).toBeUndefined();
  });

  it("подписант не резолвится в индексатора с залогом — цены нет", async () => {
    const deps = { ...passingBase(), resolveIndexer: async () => ({ ok: false, reason: "allocation_not_found" }) } as unknown as PriceDeps;
    const out = read(await handleGetVerifiedPrice({ symbol: "WETH" }, deps));
    expect(out.ok).toBe(false);
    expect(out.stage).toBe("indexer");
    expect(out.cause).toBe("allocation_not_found");
  });

  it.each([
    ["price_absent_or_zero", "у токена нет цены — спрашивать другой"],
    ["graphql_errors", "запрос отвергнут — чинить запрос"],
    ["price_stale", "рынок мёртв — не торговать"],
  ])("годность данных: %s доезжает до агента отдельным именем", async (reason) => {
    const deps = { ...passingBase(), checkUsable: () => ({ ok: false, reason }) } as unknown as PriceDeps;
    const out = read(await handleGetVerifiedPrice({ symbol: "WETH" }, deps));
    expect(out.ok).toBe(false);
    expect(out.stage).toBe("usability");
    expect(out.cause).toBe(reason);
  });

  it("возраст цены измеряется отдельно от возраста головы и доезжает в ответе", async () => {
    const out = read(await handleGetVerifiedPrice({ symbol: "WETH" }, passingBase()));
    expect(out.ok).toBe(true);
    // Два числа, не одно: голова может быть свежей при цене годовой давности.
    expect(out.checks.price_age_measured_separately).toEqual({ source_lag_blocks: "1", price_lag_blocks: "10" });
  });
});

describe("отказы платёжного пути не выдаются за отказ проверки", () => {
  it("без ключа плательщика ничего не тратится и отказ назван", async () => {
    const deps = { ...passingBase(), paidQuery: async () => ({ ok: false, reason: "no_payer_key", detail: "set X402_PRIVATE_KEY to spend" }) } as unknown as PriceDeps;
    const out = read(await handleGetVerifiedPrice({ symbol: "WETH" }, deps));
    expect(out.cause).toBe("no_payer_key");
    expect(out.stage).toBe("query");
  });

  it("сеть недоступна — это не «цена не прошла проверку»", async () => {
    const deps = { ...passingBase(), chainHead: async () => { throw new Error("connect ECONNREFUSED"); } } as unknown as PriceDeps;
    const out = read(await handleGetVerifiedPrice({ symbol: "WETH" }, deps));
    expect(out.stage).toBe("chain_head");
    expect(out.cause).toBe("chain_unreachable");
  });
});

describe("успешный ответ несёт доказательства, а не только число", () => {
  it("все четыре проверки отражены в ответе", async () => {
    const out = read(await handleGetVerifiedPrice({ symbol: "WETH" }, passingBase()));
    expect(out.ok).toBe(true);
    expect(out.checks.attestation_verified_over_raw_bytes).toBe(true);
    expect(out.checks.indexer_resolved_on_chain).toBe("0xindexer");
    expect(out.checks.reading_usable).toBe(true);
    expect(out.snapshot).toBeDefined();
    // Замер каждого этапа — чтобы «стало медленно» можно было показать, а не почувствовать.
    for (const k of ["query_ms", "attestation_ms", "chain_head_ms", "indexer_ms", "usability_ms"]) {
      expect(typeof out.timings_ms[k]).toBe("number");
    }
  });
});

// Найдено первым живым платным прогоном 10.09, а не рассуждением.
//
// Запрос возвращает `tokens(first: 5, orderBy: lastPriceBlockNumber)` — пятёрку, у которой
// цена обновилась последней. Набор меняется от блока к блоку, назвать символ заранее нельзя.
// Прогон спросил WETH, получил `token_not_found`, потратил цент и НЕ сказал, что в ответе
// было. Данные пришли проверенные, воспользоваться ими было нечем.
describe("цент обязан принести данные, а не тупик", () => {
  const withTokens = (syms: string[]) =>
    ({
      ...passingBase(),
      paidQuery: async () => ({
        ok: true, status: 200, attestationHeader: "hdr", subgraphId: "sub",
        rawBody: JSON.stringify({ data: { tokens: syms.map((s) => ({ symbol: s })) } }),
      }),
    }) as unknown as PriceDeps;

  it("без символа проверяются ВСЕ пришедшие токены", async () => {
    const deps = { ...withTokens(["LYX", "AAVE", "TREAT"]) } as unknown as PriceDeps;
    const out = read(await handleGetVerifiedPrice({} as any, deps));
    expect(out.ok).toBe(true);
    expect(out.available).toEqual(["LYX", "AAVE", "TREAT"]);
    expect(out.priced.map((p: any) => p.symbol)).toEqual(["LYX", "AAVE", "TREAT"]);
  });

  it("отказ по символу называет, что БЫЛО в ответе", async () => {
    const deps = {
      ...withTokens(["LYX", "AAVE"]),
      checkUsable: () => ({ ok: false, reason: "token_not_found" }),
    } as unknown as PriceDeps;
    const out = read(await handleGetVerifiedPrice({ symbol: "WETH" }, deps));
    expect(out.ok).toBe(false);
    expect(out.cause).toBe("token_not_found");
    expect(out.detail.available).toEqual(["LYX", "AAVE"]);
    expect(out.detail.asked).toBe("WETH");
  });

  it("отказ после платного запроса несёт замер — за него уже заплачено", async () => {
    const deps = {
      ...withTokens(["LYX"]),
      checkUsable: () => ({ ok: false, reason: "price_stale" }),
    } as unknown as PriceDeps;
    const out = read(await handleGetVerifiedPrice({ symbol: "LYX" }, deps));
    expect(out.ok).toBe(false);
    for (const k of ["query_ms", "attestation_ms", "chain_head_ms", "indexer_ms", "usability_ms"]) {
      expect(typeof out.timings_ms[k]).toBe("number");
    }
  });
});

// Адрес важнее тикера, и это куплено платным запросом, а не выведено.
describe("токен называется адресом, тикер — только когда адреса нет", () => {
  const capture = () => {
    const seen: { query?: string } = {};
    const deps = {
      ...passingBase(),
      paidQuery: async (o: any) => {
        seen.query = o?.query;
        return { ok: true, status: 200, attestationHeader: "hdr", rawBody: '{"data":{"tokens":[{"symbol":"X"}]}}' };
      },
    } as unknown as PriceDeps;
    return { seen, deps };
  };

  it("по адресу спрашивается id, а не тикер", async () => {
    const { seen, deps } = capture();
    await handleGetVerifiedPrice({ token_address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" } as any, deps);
    expect(seen.query).toMatch(/id: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"/);
    expect(seen.query).not.toMatch(/symbol:/);
  });

  it("по тикеру спрашиваются ВСЕ однофамильцы", async () => {
    const { seen, deps } = capture();
    await handleGetVerifiedPrice({ symbol: "WETH" } as any, deps);
    expect(seen.query).toMatch(/symbol: "WETH"/);
    expect(seen.query).toMatch(/first: 20/);
  });

  it("без того и другого — только токены, у которых цена есть", async () => {
    const { seen, deps } = capture();
    await handleGetVerifiedPrice({} as any, deps);
    expect(seen.query).toMatch(/lastPriceUSD_gt: 0/);
  });

  it("мусор вместо адреса отвергается до платежа", async () => {
    let paid = false;
    const deps = { ...passingBase(), paidQuery: async () => { paid = true; return { ok: true }; } } as unknown as PriceDeps;
    const out = read(await handleGetVerifiedPrice({ token_address: "WETH" } as any, deps));
    expect(out.ok).toBe(false);
    expect(out.cause).toBe("bad_request");
    expect(paid, "🔴 заплатили за заведомо негодный запрос").toBe(false);
  });
});
