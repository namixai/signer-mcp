// Reading the subgraph through The Graph's x402 gateway — the keyless path.
//
// No API key, no account: the gateway answers 402 with its price, the client signs an
// EIP-3009 authorisation for USDC on Base, and the request is retried with it.
//
// 🔴 The payment handshake is NOT hand-rolled here. The header encoding is not
// documented anywhere we could verify, and guessing it would be the same mistake as
// claiming a `requestCID` check we cannot perform. It is delegated to Coinbase's
// official `@x402/fetch`, which is also what The Graph's own `@graphprotocol/client-x402`
// uses.
//
// 🔴 THIS MODULE SPENDS MONEY. Every call is $0.01 USDC on Base. It refuses to run
// without an explicit key rather than silently falling back to an unpaid request that
// would fail for a confusing reason.

import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

export const GATEWAY = 'https://gateway.thegraph.com/api/x402/subgraphs/id';
export const TESTNET_GATEWAY = 'https://testnet.gateway.thegraph.com/api/x402/subgraphs/id';

// Base mainnet, as the live gateway challenge states.
export const PAYMENT_NETWORK = 'eip155:8453';

// Двукратный запас к нынешней цене в цент: хватает на подорожание, но не на порядок.
// Переопределяется только через окружение — см. paidQuery.
export const MAX_PER_PAYMENT_DEFAULT = '$0.02';

export const UNISWAP_V3_ETHEREUM = '4cKy6QQMc5tpfdx8yxfYeb9TLZmgLQe44ddW1G7NwkA6';

/** Price and freshness. Both fields are load-bearing; see usability.js. */
export const PRICE_QUERY = `{
  tokens(first: 5, orderBy: lastPriceBlockNumber, orderDirection: desc) {
    id symbol lastPriceUSD lastPriceBlockNumber
  }
  _meta { block { number timestamp } hasIndexingErrors }
}`;

/**
 * Ask for ONE token by its contract address.
 *
 * 🔴 A SYMBOL IS NOT A KEY, and we paid to learn it. Asking this subgraph for "WETH"
 * returned five different token entities all calling themselves WETH, every one of them
 * priced zero — the real Wrapped Ether was not among them. Anyone can deploy a token and
 * name it whatever they like, so the ticker identifies a token the way a first name
 * identifies a person. The address does not have that problem.
 *
 * The subgraph keys tokens by the lowercased address, so that is what goes in.
 */
export function priceQueryByAddress(address) {
  const id = String(address).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(id)) throw new Error(`not a contract address: ${address}`);
  return `{
  tokens(where: {id: "${id}"}) {
    id symbol lastPriceUSD lastPriceBlockNumber
  }
  _meta { block { number timestamp } hasIndexingErrors }
}`;
}

/**
 * Ask by ticker, knowing the answer may be several tokens.
 *
 * Kept because a caller may only have a ticker, but it returns everything that matches
 * so the ambiguity is visible rather than resolved by luck — taking the first row would
 * pick a namesake as often as the token meant.
 *
 * 🔴 THE LIMIT IS DECLARED, NOT HIDDEN. A page is a paid request here — a cent each — so
 * fetching pages until they run out spends an amount nobody agreed to in advance, and a
 * ticker with a thousand namesakes would empty a wallet answering one question. Instead
 * the ceiling is high enough that hitting it is remarkable, and the caller is told when
 * it is hit: `saturated` means "there may be more, and this answer cannot see them",
 * which is a different sentence from "these are all of them". Silently returning the
 * first twenty said the second while meaning the first.
 */
export const SYMBOL_MATCH_LIMIT = 100;

export function priceQueryBySymbol(symbol, limit = SYMBOL_MATCH_LIMIT) {
  const sym = String(symbol);
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(sym)) throw new Error(`not a plausible symbol: ${symbol}`);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    // The Graph caps `first` at 1000; asking for more is a query the gateway refuses —
    // and refuses AFTER charging, so the bound is checked here rather than paid for.
    throw new Error(`limit must be an integer in 1..1000, got ${limit}`);
  }
  return `{
  tokens(where: {symbol: "${sym}"}, first: ${limit}) {
    id symbol lastPriceUSD lastPriceBlockNumber
  }
  _meta { block { number timestamp } hasIndexingErrors }
}`;
}

/**
 * Read a symbol query's answer, and say whether it was cut off.
 *
 * 🔴 THE PROMISE HAS TO LIVE SOMEWHERE. `priceQueryBySymbol` above explains that
 * saturation is reported rather than inferred, and until this existed nothing in this
 * package reported it — the flag was computed by a consumer, so a caller reading these
 * files was promised a contract the files did not keep. Review on #22 caught exactly that.
 *
 * `saturated` is true when the answer holds precisely `limit` rows. That does NOT mean
 * "these are all of them" and it does not mean "there are more": it means the ceiling was
 * reached and whether anything lies beyond it cannot be seen from here. Saying that is
 * the whole point — a truncated list of namesakes could otherwise support "the token you
 * meant is not here" when the truth was "it did not fit".
 */
export function shapeSymbolMatches(rawBody, limit = SYMBOL_MATCH_LIMIT) {
  let parsed;
  try {
    parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  } catch (err) {
    return { ok: false, reason: 'body_not_json', detail: String(err?.message ?? err) };
  }
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    return { ok: false, reason: 'graphql_errors', detail: parsed.errors };
  }
  const tokens = parsed?.data?.tokens;
  if (!Array.isArray(tokens)) {
    return { ok: false, reason: 'no_tokens_field', detail: typeof tokens };
  }
  return { ok: true, tokens, saturated: tokens.length === limit, limit };
}

/**
 * The most recently priced tokens that actually carry a price.
 *
 * 🔴 The filter is the whole point. Ordering by `lastPriceBlockNumber` alone returns
 * whatever was touched last, and measured on 2026-09-10 that was five zero-priced tokens
 * twice in a row; widening to twenty gave five priced out of twenty. Three quarters of
 * what a cent buys, unusable. With the filter, five of five came back priced.
 *
 * PRICE_QUERY above is deliberately NOT changed: `LEVERAGE-EVIDENCE.md` rests on the
 * requestCID computed over its exact bytes, and a query nobody can reproduce is not
 * evidence any more.
 */
export const RECENT_PRICED_QUERY = `{
  tokens(where: {lastPriceUSD_gt: 0}, first: 5, orderBy: lastPriceBlockNumber, orderDirection: desc) {
    id symbol lastPriceUSD lastPriceBlockNumber
  }
  _meta { block { number timestamp } hasIndexingErrors }
}`;

/**
 * Decode the gateway's 402 challenge. Free — no payment is made to read it, which
 * makes it a cheap way to confirm price, network and asset before spending anything.
 */
export function decodeChallenge(headerValue) {
  if (!headerValue) return { ok: false, reason: 'no_payment_required_header' };
  let parsed;
  try {
    // `atob` + TextDecoder instead of Buffer: this has no reason to be Node-only.
    const bytes = Uint8Array.from(atob(headerValue), (c) => c.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    return { ok: false, reason: 'challenge_not_base64_json', detail: String(err?.message ?? err) };
  }
  const accept = parsed?.accepts?.[0];
  if (!accept) return { ok: false, reason: 'challenge_has_no_accepts', detail: parsed };
  // A primitive here would give `ok: true` with every field undefined — a confident
  // answer made of nothing, which is worse than an error.
  if (typeof accept !== 'object' || Array.isArray(accept)) {
    return { ok: false, reason: 'challenge_accept_not_an_object', detail: { got: typeof accept } };
  }
  // `null !== undefined`, so a null amount/asset/network sailed past an
  // undefined-only check and came back as a confident `ok: true` full of nulls.
  // Same shape as the NaN price and the empty-string recovery id: the falsy value
  // that is not the falsy value you guarded against.
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
  for (const field of ['amount', 'asset', 'network']) {
    if (!nonEmpty(accept[field])) {
      return { ok: false, reason: 'challenge_incomplete', detail: { field, value: accept[field] } };
    }
  }
  if (!/^\d+$/.test(accept.amount)) {
    return { ok: false, reason: 'challenge_amount_not_an_integer', detail: { amount: accept.amount } };
  }
  return {
    ok: true,
    x402Version: parsed.x402Version,
    network: accept.network,
    amountAtomic: accept.amount,
    asset: accept.asset,
    payTo: accept.payTo,
    transferMethod: accept.extra?.assetTransferMethod,
    // The EIP-712 domain of the payment token. Baking this wrong signs a valid
    // authorisation against the wrong contract or chain.
    tokenDomain: { name: accept.extra?.name, version: accept.extra?.version },
    maxTimeoutSeconds: accept.maxTimeoutSeconds,
  };
}

/**
 * Ask the gateway what a query costs, WITHOUT paying.
 *
 * Useful as a pre-flight and as a free liveness probe of the endpoint.
 *
 * ⚠️ A 402 does NOT prove the subgraph exists: a bogus deployment id returns the same
 * challenge, because the gateway asks for payment before resolving the id. Measured.
 */
export async function quote(subgraphId = UNISWAP_V3_ETHEREUM, query = PRICE_QUERY, gateway = GATEWAY) {
  let res;
  try {
    res = await fetch(`${gateway}/${subgraphId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      // Без срока бесплатная предпроверка блокирует весь проход демо на молчащем узле.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // No network is a named outcome, not a crash — and NOT the same as "the gateway
    // said something unexpected".
    return { ok: false, reason: 'fetch_failed', detail: String(err?.message ?? err) };
  }
  if (res.status !== 402) {
    return { ok: false, reason: 'unexpected_status', detail: { status: res.status } };
  }
  return decodeChallenge(res.headers.get('payment-required'));
}

/**
 * Paid read. Returns the RAW body bytes alongside the attestation header, because
 * `responseCID` is computed over the bytes as they arrived — re-serialising the JSON
 * changes the hash.
 *
 * @param privateKey payer key, `0x…`. Never read from a vault by this code; supplied
 *                   by whoever runs it, via X402_PRIVATE_KEY.
 */
export async function paidQuery({
  subgraphId = UNISWAP_V3_ETHEREUM,
  query = PRICE_QUERY,
  gateway = GATEWAY,
  privateKey = process.env.X402_PRIVATE_KEY,
  fetchImpl = fetch,
} = {}) {
  if (!privateKey) {
    // Refusing beats an unpaid request that 402s and looks like a gateway fault.
    return { ok: false, reason: 'no_payer_key', detail: 'set X402_PRIVATE_KEY to spend' };
  }

  let account;
  try {
    account = privateKeyToAccount(privateKey);
  } catch (err) {
    // A malformed key must fail HERE, by name, and not halfway through a payment.
    return { ok: false, reason: 'bad_payer_key', detail: String(err?.shortMessage ?? err?.message ?? err) };
  }
  // 🔴 `wrapFetchWithPayment` takes an x402 CLIENT, not a viem account: it calls
  // `client.createPaymentPayload()` after the 402. Passing the bare account made the
  // wrapper throw, so `paidQuery` would have returned `paid_request_failed` and NEVER
  // retried — a paid path that could not pay. Caught by static analysis of the
  // package's own type declarations; untestable here by running it, because spending
  // is gated. When a path cannot be exercised, the types are the only check.
  // 🔴 ПОТОЛОК НА ПЛАТЁЖ, И ОН НЕ У АГЕНТА. Ревью на signer-mcp#19 право в сути и
  // неточно в деталях: потолок тут есть и до этой правки — библиотека режет на `$1` за
  // платёж по умолчанию. Только наш запрос стоит цент, то есть защита была в СТО РАЗ
  // слабее нужной: вызов, подорожавший до девяноста девяти центов, подписался бы молча.
  //
  // Значение приходит из окружения, как и ключ: его задаёт тот, чьи деньги, а не тот,
  // кто вызывает инструмент. Аргумента для него нет намеренно — иначе агент, которому
  // дали этот модуль, поднял бы себе потолок сам.
  const client = x402Client.fromConfig({
    schemes: [{ network: PAYMENT_NETWORK, client: new ExactEvmScheme(account) }],
    spendControls: { maxAmountPerPayment: process.env.X402_MAX_PER_PAYMENT ?? MAX_PER_PAYMENT_DEFAULT },
  });
  const paidFetch = wrapFetchWithPayment(fetchImpl, client);

  let res;
  let rawBody;
  try {
    res = await paidFetch(`${gateway}/${subgraphId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    // Read as text, never as .json() — the exact bytes are the thing being attested.
    rawBody = await res.text();
  } catch (err) {
    // 🔴 Ambiguous on purpose in ONE direction only: a throw here may mean the payment
    // never happened, or that it did and the response was lost. Reported as its own
    // reason so nobody records it as "no spend" without checking the chain.
    return {
      ok: false,
      reason: 'paid_request_failed',
      detail: String(err?.shortMessage ?? err?.message ?? err),
      spendUnknown: true,
    };
  }
  const attestationHeader = res.headers.get('graph-attestation');

  return {
    ok: res.ok,
    status: res.status,
    rawBody,
    attestationHeader,
    // Absence is reported, not papered over: we have only two samples of this header
    // and must not assume the gateway always sends it.
    hasAttestation: Boolean(attestationHeader),
    payer: account.address,
  };
}
