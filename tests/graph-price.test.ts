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


// Тело в форме НАСТОЯЩЕГО ответа шлюза: `_meta.block` есть всегда, и без него снимок
// не может отличить время блока от времени наблюдения. Заглушка без него описывала бы
// ответ, которого не бывает.

// 🔴 Фикстура ЛЕЖИТ В РЕПОЗИТОРИИ, а не на чьей-то машине. Первая редакция читала её из
// /tmp на моём ноутбуке: локально зелено, в CI — ENOENT. Тест, который проходит только
// у автора, ничего не проверяет. Это запись настоящего ответа шлюза, и она едет вместе
// с кодом; сторож дрейфа сверяет её с истоком так же, как перенесённые модули.
const FIXTURE = new URL("./fixtures/sample1.body.json", import.meta.url).pathname;

const BODY = (tokens: unknown[]) =>
  JSON.stringify({
    data: { tokens, _meta: { block: { number: "1000", timestamp: "1757400000" }, hasIndexingErrors: false } },
  });

const read = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

// Заглушки, при которых проход доходит до конца. Каждый тест ломает РОВНО ОДНУ.
const passingBase = (): PriceDeps =>
  ({
    paidQuery: async () => ({ ok: true, status: 200, rawBody: BODY([]), attestationHeader: "hdr", subgraphId: "sub" }),
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
        rawBody: BODY(syms.map((s) => ({ symbol: s }))),
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
        return { ok: true, status: 200, attestationHeader: "hdr", rawBody: BODY([{ symbol: "X" }]) };
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
    // Привязано к константе, а не к числу: предел поднят по ревью #22, и тест,
    // держащий литерал, краснел бы на самой правке вместо того, чтобы её проверять.
    const { SYMBOL_MATCH_LIMIT } = await import("../src/graph/fetch.js");
    expect(seen.query).toMatch(new RegExp(`first: ${SYMBOL_MATCH_LIMIT}`));
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

// 🔴 Растяжка на проводку: все тесты выше подменяют buildSnapshot заглушкой, которая
// всегда соглашается. Из-за этого настоящая сборка снимка не проверялась НИ РАЗУ — и
// первый же платный прогон, дошедший до неё, вернул `bad_request: subgraphId missing`.
// Я передавал `q.subgraphId`, которого paidQuery не возвращает. Цент за мою ошибку.
//
// Здесь настоящие usability и snapshot и настоящий записанный ответ с прода: подменены
// только сеть и платёж. Тест падает, если проводка снова разойдётся.
describe("сборка снимка проверяется настоящей, а не заглушкой", () => {
  it("реальный ответ проходит до снимка и даёт цену", async () => {
    const { readFileSync } = await import("node:fs");
    const body = readFileSync(
      FIXTURE,
      "utf8",
    );
    const meta = JSON.parse(body).data._meta.block;
    const real = {
      ...(await import("../src/graph/usability.js")),
      ...(await import("../src/graph/snapshot.js")),
    };
    // Настоящая проверка подписи над настоящей записанной парой «тело + аттестация».
    // Заглушка на её месте не несла requestCID и responseCID, и снимок отказывался
    // собираться — то есть заглушка скрывала бы ровно ту проводку, ради которой тест есть.
    const att = await import("../src/graph/attestation.js");
    const attRaw = readFileSync(
      FIXTURE.replace(".body.json", ".attestation.json"),
      "utf8",
    );
    const deps = {
      ...real,
      ...att,
      paidQuery: async () => ({ ok: true, status: 200, rawBody: body, attestationHeader: attRaw }),
      // Голова цепи берётся из САМОГО ответа: иначе запись четырёхдневной давности
      // законно отвергается как source_stale, и тест ловил бы возраст, а не проводку.
      chainHead: async () => BigInt(meta.number),
      resolveIndexer: async () => ({ ok: true, indexer: "0xind" }),
      arbitrumClient: () => ({}),
    } as unknown as PriceDeps;

    // 🔴 ОБА способа адресации, а не один. Первый раз этот тест гонял только тикер, и
    // путь по адресу ушёл в бой непроверенным: снимок отказался собираться, потому что
    // при поиске по адресу тикера нет. Дважды подряд платный прогон находил дыру там,
    // куда тест не заглядывал, — поэтому здесь перебор, а не один случай.
    const wethId = JSON.parse(body).data.tokens.find((t: any) => t.symbol === "WETH")?.id;
    expect(wethId, "в записанном ответе нет WETH — фикстура не та").toBeTruthy();

    for (const [how, args] of [
      ["по тикеру", { symbol: "WETH" }],
      ["по адресу", { token_address: wethId }],
    ] as const) {
      const out = read(await handleGetVerifiedPrice(args as any, deps));
      expect(out.ok, `${how}: сборка отказала — ${out.cause} / ${JSON.stringify(out.detail)}`).toBe(true);
      expect(out.snapshot, how).toBeDefined();
      expect(out.priced[0].symbol, how).toBe("WETH");
      expect(Number(out.priced[0].price_usd), how).toBeGreaterThan(0);

      // 🔴 Единственная подписываемая форма. Ответ ронял `dataText`, то есть подписывать
      // было нечего. Пересобрать его из `snapshot` нельзя: другой сериализатор даст
      // другой порядок ключей и другие пробелы, подпись ляжет на другие байты и не
      // сойдётся. Поэтому проверяем не «поле есть», а что оно НЕСЁТ ТОТ ЖЕ снимок и что
      // его длина совпадает с объявленной.
      expect(typeof out.dataText, `${how}: dataText потерян — подписывать нечего`).toBe("string");
      expect(JSON.parse(out.dataText), how).toEqual(out.snapshot);
      expect(new TextEncoder().encode(out.dataText).length, how).toBe(out.bytes);
    }
  });

  // 🔴 Доказательство, что время блока действительно ЧИТАЕТСЯ из ответа. Раньше сюда
  // подставлялось время наблюдения, отчего проверка «снимок старше описываемого блока»
  // становилась тождественно истинной: она стояла и не могла сработать никогда.
  // Блок из будущего обязан быть отвергнут — иначе значение снова берётся не оттуда.
  it("блок из будущего отвергается: время берётся из ответа, а не подставляется", async () => {
    const { readFileSync } = await import("node:fs");
    const orig = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const future = JSON.parse(JSON.stringify(orig));
    future.data._meta.block.timestamp = String(Math.floor(Date.now() / 1000) + 86_400);
    const bodyFuture = JSON.stringify(future);

    const real = {
      ...(await import("../src/graph/usability.js")),
      ...(await import("../src/graph/snapshot.js")),
      ...(await import("../src/graph/attestation.js")),
    };
    const deps = {
      ...real,
      // Подпись здесь не проверяем: тело изменено, и настоящая проверка законно отвергла
      // бы его раньше, чем мы дошли бы до сборки. Проверяем именно порядок времён.
      parseAttestationHeader: () => ({}),
      verifyAttestation: async () => ({
        ok: true, allocationId: "0x1", subgraphDeploymentID: "0x2",
        requestCID: "0xreq", responseCID: "0xres",
      }),
      paidQuery: async () => ({ ok: true, status: 200, rawBody: bodyFuture, attestationHeader: "h" }),
      chainHead: async () => BigInt(orig.data._meta.block.number),
      resolveIndexer: async () => ({ ok: true, indexer: "0xind" }),
      arbitrumClient: () => ({}),
    } as unknown as PriceDeps;

    const out = read(await handleGetVerifiedPrice({ symbol: "WETH" }, deps));
    expect(out.ok).toBe(false);
    expect(out.cause, "проверка порядка времён не сработала — значение снова не из ответа").toBe("observed_before_block");
  });
});

// Ревью на #22 (Major): срезка выдачи была молчаливой. Пагинация не годится — КАЖДАЯ
// страница здесь платная, и тикер с тысячей однофамильцев опустошил бы кошелёк на одном
// вопросе. Потолок поднят и объявлен, а насыщение вызывающий обязан увидеть словом.
describe("срезка выдачи по тикеру видна вызывающему", () => {
  const bodyOf = (n: number) =>
    JSON.stringify({
      data: {
        tokens: Array.from({ length: n }, (_, i) => ({ symbol: "WETH", id: `0x${i}` })),
        _meta: { block: { number: "1000", timestamp: "1757400000" }, hasIndexingErrors: false },
      },
    });
  const depsFor = (n: number) =>
    ({ ...passingBase(), paidQuery: async () => ({ ok: true, status: 200, rawBody: bodyOf(n), attestationHeader: "h" }) }) as unknown as PriceDeps;

  it("ровно на потолке отвечает truncated: true — «есть ли ещё, отсюда не видно»", async () => {
    const out = read(await handleGetVerifiedPrice({ symbol: "WETH" }, depsFor(100)));
    expect(out.truncated, "насыщение не показано — срезка снова молчаливая").toBe(true);
  });

  it("ниже потолка — truncated: false, это действительно все совпадения", async () => {
    const out = read(await handleGetVerifiedPrice({ symbol: "WETH" }, depsFor(3)));
    expect(out.truncated).toBe(false);
  });

  it("по адресу насыщения быть не может: адрес опознаёт один токен", async () => {
    const out = read(await handleGetVerifiedPrice({ token_address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" }, depsFor(100)));
    expect(out.truncated).toBe(false);
  });
});

// Недоступность цепи не повод покупать заново.
//
// 🔴 Растяжка на исходник, и я говорю это прямо: логика повтора живёт в скрипте, который
// исполняется при импорте, поэтому поведенчески её отсюда не завести. Проверка держит то
// единственное, что имеет цену, — что `chain_unreachable` НЕ в множестве повторяемых.
// К моменту этого отказа платный ответ уже куплен и подпись проверена; повтор берёт
// новые данные Graph, которые не нужны, и перебои RPC съедают весь потолок попыток.
describe("повтор не покупает заново то, что уже куплено", () => {
  it("chain_unreachable выведен из повторяемых причин", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../scripts/retry-until-clean.mjs", import.meta.url), "utf8");
    const transient = /const TRANSIENT = new Set\((\[[^\]]*\])\)/.exec(src);
    expect(transient, "множество повторяемых причин не найдено — скрипт переписали").toBeTruthy();
    const causes: string[] = JSON.parse(transient![1].replace(/'/g, '"'));
    expect(causes).not.toContain("chain_unreachable");
    // И остаётся повторяемым то, что действительно потеряно в доставке.
    expect(causes).toContain("paid_request_failed");
  });
});

// Четыре находки из тела ревью на #19: тул не имеет права падать, и негодный вход не
// имеет права стоить денег.
describe("платный путь не роняет инструмент и не берёт денег за заведомо негодное", () => {
  const withHeader = async (hdr: unknown) => {
    const A = await import("../src/graph/attestation.js");
    return {
      ...passingBase(),
      paidQuery: async () => ({ ok: true, status: 200, rawBody: BODY([{ symbol: "X" }]), attestationHeader: hdr }),
      parseAttestationHeader: A.parseAttestationHeader,
    } as unknown as PriceDeps;
  };

  it("отсутствующий и кривой заголовок аттестации — отказ по имени, а не исключение", async () => {
    for (const [hdr, cause] of [
      [null, "attestation_header_missing"],
      ["не json", "attestation_header_unreadable"],
    ] as const) {
      const out = read(await handleGetVerifiedPrice({ symbol: "X" }, await withHeader(hdr)));
      expect(out.ok).toBe(false);
      expect(out.cause).toBe(cause);
    }
  });

  it("дробная полоса отвергается ДО оплаты", async () => {
    let paid = false;
    const deps = { ...passingBase(), paidQuery: async () => { paid = true; return { ok: true }; } } as unknown as PriceDeps;
    for (const bad of [12.5, -1, 10_001, NaN, "5"]) {
      const out = read(await handleGetVerifiedPrice({ symbol: "X", band_bps: bad } as any, deps));
      expect(out.ok, `принята полоса ${String(bad)}`).toBe(false);
      expect(out.cause).toBe("bad_request");
    }
    expect(paid, "🔴 заплатили за запрос, который всё равно бы упал").toBe(false);
    // Целые в диапазоне обязаны проходить, иначе проверка просто запрещает полосу.
    const good = read(await handleGetVerifiedPrice({ symbol: "X", band_bps: 250 } as any, passingBase()));
    expect(good.ok).toBe(true);
  });

  it("null во времени блока не проходит: Number(null) это 0, а ноль конечен", async () => {
    const body = JSON.parse(BODY([{ symbol: "X" }]));
    for (const bad of [null, "", false, 0, -5]) {
      body.data._meta.block.timestamp = bad;
      const deps = {
        ...passingBase(),
        paidQuery: async () => ({ ok: true, status: 200, rawBody: JSON.stringify(body), attestationHeader: "h" }),
      } as unknown as PriceDeps;
      const out = read(await handleGetVerifiedPrice({ symbol: "X" }, deps));
      expect(out.ok, `прошло время блока ${JSON.stringify(bad)}`).toBe(false);
      expect(out.cause).toBe("missing_block_timestamp");
    }
  });

  it("не-2xx ответ несёт статус, а не пустую причину", async () => {
    const deps = { ...passingBase(), paidQuery: async () => ({ ok: false, status: 503 }) } as unknown as PriceDeps;
    const out = read(await handleGetVerifiedPrice({ symbol: "X" }, deps));
    expect(out.cause).toBe("query_failed");
    expect(out.detail).toEqual({ status: 503 });
  });
});
