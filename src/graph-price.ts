// A price an agent can act on, and the four checks that decide whether it may.
//
// The gateway will sell you a number without any of this. What makes the number
// worth a signature is what comes back with it:
//
//   1. the indexer signed the EXACT bytes that arrived      (attestation.js)
//   2. that signer is an indexer with stake, read on chain  (chain.js)
//   3. the reading is a usable price at all                 (usability.js)
//   4. the price's age, measured apart from the head's age  (usability.js)
//
// 🔴 A tool that returns the price without them is a GraphQL client with extra
// steps, so none of the four is optional here and none is allowed to fail quietly.
//
// 🔴 WHERE THIS RUNS: outside the enclave, like everything else that touches a
// network. It reads and decides; it signs nothing a venue would execute.

import {
  paidQuery, priceQueryByAddress, priceQueryBySymbol,
  RECENT_PRICED_QUERY, UNISWAP_V3_ETHEREUM, shapeSymbolMatches,
} from "./graph/fetch.js";
import { verifyAttestation, parseAttestationHeader } from "./graph/attestation.js";
import { chainHead, resolveIndexer, arbitrumClient } from "./graph/chain.js";
import { checkUsable } from "./graph/usability.js";
import { buildSnapshot } from "./graph/snapshot.js";
import { toolJson, type ToolResult } from "./lib.js";

/**
 * The seam the tests drive through.
 *
 * 🔴 IT IS A SECOND PARAMETER, NOT A FIELD OF THE INPUT. A test hook reachable from
 * the tool's own arguments is a back door: an agent could pass it and swap the very
 * checks this tool exists to run. The registration below calls the handler with one
 * argument, the input schema has no such key, and nothing an agent sends can reach here.
 */
export interface PriceDeps {
  paidQuery: typeof paidQuery;
  parseAttestationHeader: typeof parseAttestationHeader;
  verifyAttestation: typeof verifyAttestation;
  chainHead: typeof chainHead;
  resolveIndexer: typeof resolveIndexer;
  arbitrumClient: typeof arbitrumClient;
  checkUsable: typeof checkUsable;
  buildSnapshot: typeof buildSnapshot;
}

const REAL_DEPS: PriceDeps = {
  paidQuery, parseAttestationHeader, verifyAttestation,
  chainHead, resolveIndexer, arbitrumClient, checkUsable, buildSnapshot,
};

export interface VerifiedPriceInput {
  /** Contract address. The only way to name a token without ambiguity. */
  token_address?: string;
  /** Ticker. Accepted, but it can match several tokens — see the note in the answer. */
  symbol?: string;
  subgraph_id?: string;
  band_bps?: number;
}

type Stage = "query" | "attestation" | "chain_head" | "indexer" | "usability" | "snapshot";

const ms = () => Date.now();

/**
 * The refusal an agent can act on.
 *
 * 🔴 TWO NAMES, NOT ONE. `stage` says which check stopped us; `cause` is the name
 * that check itself used. Collapsing them loses the actionable half: an agent that
 * reads only "reading_not_usable" cannot tell `price_absent_or_zero` (this token has
 * no price — ask for a different one) from `graphql_errors` (the query was refused —
 * retry or fix it) from `price_stale` (the market is dead — do not trade on it).
 * Those three are fixed in three different places, and only `cause` distinguishes them.
 */
function refuse(
  stage: Stage,
  cause: string,
  detail: unknown = null,
  timings?: Record<string, number>,
): ToolResult {
  return toolJson({
    ok: false,
    stage,
    cause,
    detail: detail ?? null,
    checked: false,
    // 🔴 Отказ после платного запроса обязан нести замер: цент уже потрачен, и
    // «сколько это заняло» — единственное, что за него ещё можно узнать.
    ...(timings ? { timings_ms: timings } : {}),
    note:
      "No price is returned. A refusal here is a decision, not an outage — read `cause` " +
      "before retrying, because these are not fixed the same way.",
  });
}

export async function handleGetVerifiedPrice(
  args: VerifiedPriceInput,
  deps: PriceDeps = REAL_DEPS,
): Promise<ToolResult> {
  // 🔴 Символ НЕОБЯЗАТЕЛЕН, и это следствие того, что запрос на самом деле возвращает:
  // пять токенов, у которых цена обновилась последними. Набор меняется от блока к блоку,
  // так что назвать символ заранее нельзя — можно только угадать. Первый живой платный
  // прогон 10.09 угадал неверно и вернул `token_not_found`, потратив цент и не сказав,
  // что в ответе БЫЛО. Без символа проверяются все пятеро, и цент всегда приносит данные.
  const symbol = typeof args?.symbol === "string" && args.symbol !== "" ? args.symbol : null;
  const address = typeof args?.token_address === "string" && args.token_address !== "" ? args.token_address : null;

  // 🔴 ADDRESS FIRST, and the ticker only when there is nothing better. Asking this
  // subgraph for "WETH" returned five different tokens all called WETH, all priced zero,
  // and the real Wrapped Ether was not among them — measured on a paid query, 2026-09-10.
  // Anyone can deploy a token and name it anything, so a ticker names a token about as
  // precisely as a first name names a person.
  // 🔴 ПОЛОСА ПРОВЕРЯЕТСЯ ДО ОПЛАТЫ. Дробное значение доезжало до BigInt внутри снимка и
  // роняло проход RangeError'ом — то есть цент уже потрачен, а ответа нет и отказа по
  // имени тоже нет. Негодный вход обязан стоить ноль.
  if (args.band_bps !== undefined) {
    const b = args.band_bps;
    if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 10_000) {
      return refuse("query", "bad_request", `band_bps must be a whole number of basis points in 0..10000, got ${String(b)}`);
    }
  }

  let query: string;
  try {
    query = address
      ? priceQueryByAddress(address)
      : symbol
        ? priceQueryBySymbol(symbol)
        : RECENT_PRICED_QUERY;
  } catch (err: any) {
    return refuse("query", "bad_request", String(err?.message ?? err));
  }
  const timings: Record<string, number> = {};

  // 1. The paid read. paidQuery refuses `no_payer_key` by name when X402_PRIVATE_KEY
  //    is unset — deliberately NOT re-implemented here. This tool never invents a
  //    payer: if the operator has not set a key, nothing is spent and nothing is faked.
  let t = ms();
  const q: any = await deps.paidQuery({ query, ...(args.subgraph_id ? { subgraphId: args.subgraph_id } : {}) });
  timings.query_ms = ms() - t;
  if (!q?.ok) {
    // Статус несём всегда: «query_failed» без него не отличает 503 шлюза от отказа платежа.
    const detail = q?.detail ?? (q?.status !== undefined ? { status: q.status } : null);
    return refuse("query", String(q?.reason ?? "query_failed"), detail, timings);
  }

  // 2. The signature over the bytes AS THEY ARRIVED. Re-serialising the JSON first
  //    changes the hash, so the raw body travels untouched from fetch to here.
  t = ms();
  // 🔴 Разбор заголовка БРОСАЕТ на отсутствующем и на кривом — это его контракт. Инструмент
  // обязан отказать по имени, а не упасть: к этому месту платёж уже прошёл, и падение
  // отнимает у вызывающего и деньги, и причину.
  let verification: any;
  try {
    const attestation = deps.parseAttestationHeader(q.attestationHeader);
    verification = await deps.verifyAttestation(q.rawBody, attestation);
  } catch (err: any) {
    return refuse(
      "attestation",
      q.attestationHeader ? "attestation_header_unreadable" : "attestation_header_missing",
      String(err?.message ?? err),
      timings,
    );
  }
  timings.attestation_ms = ms() - t;
  if (!verification?.ok) {
    return refuse("attestation", String(verification?.reason ?? "attestation_failed"), verification?.detail);
  }

  // 3. The chain head, needed before usability: an age is meaningless without it.
  t = ms();
  let head: bigint;
  try {
    head = await deps.chainHead();
  } catch (err: any) {
    return refuse("chain_head", "chain_unreachable", String(err?.shortMessage ?? err?.message ?? err));
  }
  timings.chain_head_ms = ms() - t;

  // 4. Who signed it, and do they have stake. An on-chain read, which is exactly why
  //    none of this can happen inside an enclave: an enclave has no network.
  t = ms();
  const indexer: any = await deps.resolveIndexer(
    verification.allocationId,
    verification.subgraphDeploymentID,
    deps.arbitrumClient(),
  );
  timings.indexer_ms = ms() - t;
  if (!indexer?.ok) {
    return refuse("indexer", String(indexer?.reason ?? "indexer_not_resolved"), indexer?.detail);
  }

  // 5. Is it a price at all. A verified signature over "null" is still not a price,
  //    and this is the check that says so by name.
  t = ms();
  let parsed: unknown;
  try {
    parsed = JSON.parse(q.rawBody);
  } catch (err: any) {
    return refuse("usability", "body_not_json", String(err?.message ?? err));
  }
  // 🔴 Насыщение выдачи вызывающий обязан УВИДЕТЬ. Ровно `SYMBOL_MATCH_LIMIT` строк
  // означает не «это все», а «столько поместилось, и есть ли ещё — отсюда не видно».
  // Раньше срезка была молчаливой, и «настоящего среди них нет» могло на самом деле
  // значить «настоящий не попал в выдачу» — то есть находка про неуникальность тикера
  // выглядела бы сильнее, чем данные её держат.
  // Считает исток, а не эта копия: два места, вычисляющих одно и то же, расходятся
  // молча, и уже расходились — флаг жил здесь, пока комментарий в fetch.js обещал его там.
  const shaped: any = shapeSymbolMatches(parsed as object);
  // 🔴 Отказ разбора ПРОБРАСЫВАЕТСЯ, а не проглатывается. Раньше при `ok: false` код шёл
  // дальше на том же разобранном теле: без `data.tokens` список оказывался пустым и
  // вызывающий получал общее `not_usable` вместо точного `no_tokens_field`, а `detail`
  // терялся. Причина, которую заменили на менее точную, — та же потеря, что и молчание.
  if (shaped?.ok !== true) {
    return refuse("usability", String(shaped?.reason ?? "unshapeable_response"), shaped?.detail, timings);
  }
  const saturated = symbol !== null && address === null && shaped.saturated === true;

  const rows: any[] = Array.isArray((parsed as any)?.data?.tokens) ? (parsed as any).data.tokens : [];
  const available: string[] = Array.isArray((parsed as any)?.data?.tokens)
    ? (parsed as any).data.tokens.map((x: any) => x?.symbol).filter(Boolean)
    : [];

  // По адресу вернётся ровно один токен — проверяем его, каким бы ни был его тикер.
  // 🔴 КАЖДАЯ СТРОКА ПРОВЕРЯЕТСЯ ОТДЕЛЬНО. Раньше на каждый токен уходил ОДИН И ТОТ ЖЕ
  // полный ответ и его тикер, а `checkUsable` ищет по тикеру — так что при пяти строках
  // с именем WETH пять проверок разбирали одну и ту же первую строку и повторяли её
  // вердикт пятикратно. Ровно там, где неуникальность тикера и есть предмет разговора.
  const meta = (parsed as any)?.data?._meta;
  const isolate = (row: any) => ({ data: { tokens: [row], _meta: meta } });
  const wanted: any[] = address || !symbol ? rows : rows.filter((r: any) => r?.symbol === symbol);
  const checked = wanted.map((row: any) => ({
    symbol: row?.symbol,
    id: row?.id,
    result: deps.checkUsable(isolate(row), row?.symbol, head) as any,
  }));
  timings.usability_ms = ms() - t;

  const good = checked.filter((c) => c.result?.ok === true);
  if (checked.length === 0) {
    // Ни одна строка не подошла под запрошенное. Это ОТДЕЛЬНАЯ причина, а не «непригодно»:
    // «такого токена в ответе нет» и «токен есть, но цены у него нет» чинятся по-разному —
    // первое сменой запроса, второе ничем.
    return refuse(
      "usability",
      "token_not_found",
      { asked: symbol ?? address ?? "(все пришедшие)", available, truncated: saturated },
      timings,
    );
  }
  if (good.length === 0) {
    const first = checked[0]?.result;
    return refuse(
      "usability",
      String(first?.reason ?? "not_usable"),
      // 🔴 Что БЫЛО в ответе — часть отказа, а не догадка вызывающего. Иначе цент куплен
      // впустую: данные пришли и проверены, а воспользоваться ими нельзя.
      { asked: symbol ?? "(все пришедшие)", available, truncated: saturated, per_symbol: checked.map((c) => ({ symbol: c.symbol, reason: c.result?.reason ?? null })) },
      timings,
    );
  }
  const usability: any = good[0].result;

  // 6. The answer, which states what was NOT checked as plainly as what was.
  const observedAtMs = ms();
  // Отметка времени блока приходит в самом ответе, в секундах.
  const rawTs = (parsed as any)?.data?._meta?.block?.timestamp;
  // 🔴 `Number(null)` — это 0, а ноль конечен. Прежняя проверка на конечность пропускала
  // null, пустую строку и false, снимок собирался со временем блока в начале эпохи, и
  // проверка порядка времён при этом молчала. Отсутствующее значение проваливалось в
  // умолчание и голосовало. Требуем положительное число и ничего кроме.
  const tsNum = typeof rawTs === "string" || typeof rawTs === "number" ? Number(rawTs) : NaN;
  const blockTsMs = Number.isFinite(tsNum) && tsNum > 0 ? tsNum * 1000 : NaN;
  if (!Number.isFinite(blockTsMs)) {
    return refuse("snapshot", "missing_block_timestamp", { got: rawTs ?? null }, timings);
  }
  const snap: any = deps.buildSnapshot({
    // 🔴 `paidQuery` НЕ возвращает subgraph id — я решил, что возвращает, и снимок
    // отказывался собираться с `bad_request: subgraphId missing`. Нашлось платным
    // прогоном 10.09: прежние падали на годности и до сборки не доходили. Берём тот же
    // умолчательный идентификатор, которым запрос и уходил.
    subgraphId: args.subgraph_id ?? UNISWAP_V3_ETHEREUM,
    // 🔴 Тикер НАЙДЕННОГО токена, а не спрошенного. При поиске по адресу спрошенного
    // тикера нет вовсе, и снимок отказывался собираться с `bad_request: symbol missing` —
    // второй платный прогон, второй раз одна и та же дыра: путь, которого не касался ни
    // один тест. Заодно так правильнее по смыслу: снимок описывает то, что вернулось.
    symbol: good[0].symbol ?? usability.symbol ?? symbol,
    verification,
    usability,
    indexer,
    chainHead: head,
    observedAtMs,
    // 🔴 ВРЕМЯ БЛОКА, А НЕ ВРЕМЯ НАБЛЮДЕНИЯ. Раньше здесь стояло `observedAtMs`, и это
    // не «неточность»: у снимка есть проверка `observed_before_block`, ловящая запись,
    // которая claims быть старше блока, который описывает. Подставляя одно и то же
    // значение с обеих сторон, я делал её тождественно истинной — проверка стояла и не
    // могла сработать никогда. Найдено чтением контракта buildSnapshot, а не платным
    // прогоном; предыдущие два таких же нашлись за цент каждый.
    blockTimestampMs: blockTsMs,
    ...(typeof args.band_bps === "number" ? { bandBps: args.band_bps } : {}),
  });
  if (!snap?.ok) {
    return refuse("snapshot", String(snap?.refusal?.reason ?? "snapshot_refused"), snap?.refusal?.detail);
  }

  return toolJson({
    ok: true,
    snapshot: snap.snapshot,
    // 🔴 ЕДИНСТВЕННАЯ ПОДПИСЫВАЕМАЯ ФОРМА. `dataText` — это точные байты, которые
    // buildSnapshot сериализовал и которые предназначены к подписи ключом данных.
    // Собрать их заново из `snapshot` нельзя: порядок ключей и пробелы у другого
    // сериализатора будут иными, подпись ляжет на другие байты и не сойдётся. Ответ
    // ронял это поле, то есть подписывать было нечего. Ревью CodeRabbit на #19.
    dataText: snap.dataText,
    bytes: snap.bytes,
    checks: {
      attestation_verified_over_raw_bytes: true,
      indexer_resolved_on_chain: indexer.indexer,
      reading_usable: true,
      price_age_measured_separately: {
        source_lag_blocks: usability.sourceLagBlocks,
        price_lag_blocks: usability.priceLagBlocks,
      },
    },
    timings_ms: timings,
    available,
    truncated: saturated,
    priced: good.map((c) => ({ symbol: c.symbol, token_address: c.id ?? null, price_usd: c.result.priceUSD, price_block: c.result.priceBlock })),
    refused: checked.filter((c) => c.result?.ok !== true).map((c) => ({ symbol: c.symbol, reason: c.result?.reason ?? null })),
  });
}
