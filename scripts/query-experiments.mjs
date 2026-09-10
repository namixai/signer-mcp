#!/usr/bin/env node
// Четыре платных запроса, каждый отвечает на свой вопрос.
//
// Повод: два прогона подряд купили непригодные данные. Запрос просит
// `tokens(first: 5, orderBy: lastPriceBlockNumber desc)` — пятёрку, которой коснулись
// последними, — и это сплошь неликвид с ценой 0. Четыре проверки при этом отработали
// правильно: ломается не проверка, а то, ЧТО мы покупаем.
//
// 🔴 ПОТОЛОК ОБЪЯВЛЕН И ЖЁСТКИЙ: ровно столько запросов, сколько опытов, по центу каждый.
// Скрипт показывает сумму до списания и останавливается. Больше потолка не тратит никогда.

import { paidQuery } from '../dist/graph/fetch.js';
import { verifyAttestation, parseAttestationHeader } from '../dist/graph/attestation.js';
import { chainHead, resolveIndexer, arbitrumClient } from '../dist/graph/chain.js';
import { checkUsable } from '../dist/graph/usability.js';
import { createPublicClient, http, erc20Abi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { openSync, readSync, closeSync } from 'node:fs';
import { interpretConfirmation } from '../dist/confirm.js';

const META = '_meta { block { number timestamp } hasIndexingErrors }';
const F = 'id symbol lastPriceUSD lastPriceBlockNumber';

const EXPERIMENTS = [
  { name: 'A. спросить именно WETH',
    why: 'инструмент принимает символ — умеет ли запрос его спросить, а не тянуть пятёрку наугад',
    q: `{ tokens(where: {symbol: "WETH"}, first: 5) { ${F} } ${META} }` },
  { name: 'B. последние, но с ненулевой ценой',
    why: 'чинит ли фильтр лотерею для режима «без символа»',
    q: `{ tokens(where: {lastPriceUSD_gt: 0}, first: 5, orderBy: lastPriceBlockNumber, orderDirection: desc) { ${F} } ${META} }` },
  { name: 'C. двадцать последних без фильтра',
    why: 'сколько из двадцати вообще имеют цену — мера самой лотереи',
    q: `{ tokens(first: 20, orderBy: lastPriceBlockNumber, orderDirection: desc) { ${F} } ${META} }` },
  { name: 'D. пятёрка по ликвидности',
    why: 'другая сортировка целиком: даёт ли TVL то, чего не даёт время',
    q: `{ tokens(first: 5, orderBy: totalValueLockedUSD, orderDirection: desc) { ${F} } ${META} }` },
];

const key = process.env.X402_PRIVATE_KEY;
if (!key) { console.error('X402_PRIVATE_KEY пуст.'); process.exit(2); }
let account;
try { account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`); }
catch { console.error('Ключ не разобран. Ключ не печатаю.'); process.exit(2); }

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const client = createPublicClient({ chain: base, transport: http() });
const bal = () => client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });

const before = await bal();
const cost = EXPERIMENTS.length;
console.log(`
  ПЛАТИТ    ${account.address}
  баланс    ${formatUnits(before, 6)} USDC
  ОПЫТОВ    ${cost}, по 0.01 USDC = СПИСАНИЕ ДО ${(cost * 0.01).toFixed(2)} USDC
  остаток   ${(Number(formatUnits(before, 6)) - cost * 0.01).toFixed(6)} USDC после
`);
if (Number(formatUnits(before, 6)) < cost * 0.01) { console.error('Баланса не хватает на весь набор. Ничего не списано.'); process.exit(2); }

process.stderr.write(`Запустить ${cost} платных запроса? Enter — да, Ctrl-C — нет: `);
const tty = openSync('/dev/tty', 'r');
const buf = Buffer.alloc(64);
const n = readSync(tty, buf, 0, 64, null);
closeSync(tty);
const verdict = interpretConfirmation(n, buf);
if (!verdict.ok) {
  const msg = verdict.reason === 'eof'
    ? 'Ввод закрыт (EOF), подтверждения не было. Ничего не списано.'
    : `Понято как отказ: ${JSON.stringify(verdict.answer)}. Ничего не списано.`;
  console.error('');
  console.error(msg);
  process.exit(2);
}

const head = await chainHead();
for (const e of EXPERIMENTS) {
  const t0 = Date.now();
  const q = await paidQuery({ query: e.q });
  const qms = Date.now() - t0;
  console.log(`\n${'─'.repeat(72)}\n${e.name}\n  зачем: ${e.why}`);
  if (!q.ok) { console.log(`  🔴 запрос не удался: ${q.reason} ${q.detail ?? ''}`); continue; }

  const v = await verifyAttestation(q.rawBody, parseAttestationHeader(q.attestationHeader));
  let who = null;
  if (v.ok) who = await resolveIndexer(v.allocationId, v.subgraphDeploymentID, arbitrumClient());

  let body; try { body = JSON.parse(q.rawBody); } catch { console.log('  тело не JSON'); continue; }
  if (body.errors) { console.log('  GraphQL errors:', JSON.stringify(body.errors).slice(0, 200)); continue; }
  const toks = body?.data?.tokens ?? [];
  const priced = toks.filter((x) => x.lastPriceUSD && Number(x.lastPriceUSD) > 0);

  console.log(`  запрос ${qms} мс | подпись ${v.ok ? 'ок' : '🔴 ' + v.reason} | индексатор ${who?.ok ? who.indexer.slice(0, 10) + '…' : '🔴 ' + (who?.reason ?? '—')}`);
  console.log(`  токенов ${toks.length}, с ненулевой ценой ${priced.length}`);
  for (const x of toks.slice(0, 8)) {
    const u = checkUsable(body, x.symbol, head);
    console.log(`    ${String(x.symbol).padEnd(8)} ${String(x.lastPriceUSD).slice(0, 14).padEnd(15)} проверка: ${u.ok ? 'ГОДНА' : u.reason}`);
  }
  if (toks.length > 8) console.log(`    … ещё ${toks.length - 8}`);
}

const after = await bal();
console.log(`\n${'─'.repeat(72)}`);
console.log(`  потрачено за набор: ${(Number(formatUnits(before - after, 6))).toFixed(6)} USDC`);
console.log(`  остаток           : ${formatUnits(after, 6)} USDC (${Math.floor(Number(formatUnits(after, 6)) / 0.01)} запросов)`);
