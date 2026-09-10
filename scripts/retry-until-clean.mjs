#!/usr/bin/env node
// Повторять — только то, что имеет смысл повторять.
//
//   X402_PRIVATE_KEY="$K" node scripts/retry-until-clean.mjs
//
// 🔴 РАЗНИЦА МЕЖДУ СБОЕМ И ОТВЕТОМ — ВСЯ СУТЬ. `paid_request_failed` это потерянный
// ответ: повтор осмыслен. `price_absent_or_zero` это ОТВЕТ — у токена нет цены, и
// повтор купит ровно тот же ответ ещё раз. Первое повторяем, второе никогда.
//
// 🔴 ПОТОЛОК ЖЁСТКИЙ. Каждая попытка стоит цент. MAX_ATTEMPTS ограничивает трату
// сверху, а баланс сверяется по цепи ДО и ПОСЛЕ, потому что читать его сразу после
// серии — значит недосчитать: платёж оседает не мгновенно (проверено 10.09, четвёртый
// платёж батча не был виден в момент замера).

import { handleGetVerifiedPrice } from '../dist/graph-price.js';
import { createPublicClient, http, erc20Abi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { openSync, readSync, closeSync } from 'node:fs';

const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 5);
const TOKEN = process.env.TOKEN ?? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// Сбой доставки: ответа не было, повтор осмыслен.
const TRANSIENT = new Set(['paid_request_failed', 'query_failed', 'chain_unreachable', 'verify_unreachable', 'verify_no_verdict']);

const key = process.env.X402_PRIVATE_KEY;
if (!key) { console.error('X402_PRIVATE_KEY пуст.'); process.exit(2); }
let account;
try { account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`); }
catch { console.error('Ключ не разобран. Ключ не печатаю.'); process.exit(2); }

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const c = createPublicClient({ chain: base, transport: http() });
const bal = () => c.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });

const before = await bal();
console.log(`
  ПЛАТИТ    ${account.address}
  баланс    ${formatUnits(before, 6)} USDC
  токен     ${TOKEN}
  ПОТОЛОК   ${MAX_ATTEMPTS} попыток × 0.01 = до ${(MAX_ATTEMPTS * 0.01).toFixed(2)} USDC
  повторяем ТОЛЬКО сбои доставки: ${[...TRANSIENT].join(', ')}
`);
if (Number(formatUnits(before, 6)) < MAX_ATTEMPTS * 0.01) { console.error('Баланса не хватает на потолок. Ничего не списано.'); process.exit(2); }

process.stderr.write('Запустить? Enter — да, Ctrl-C — нет: ');
const tty = openSync('/dev/tty', 'r'); readSync(tty, Buffer.alloc(8), 0, 8, null); closeSync(tty);

let out = null;
for (let i = 1; i <= MAX_ATTEMPTS; i++) {
  const t0 = Date.now();
  const res = await handleGetVerifiedPrice({ token_address: TOKEN });
  out = JSON.parse(res.content[0].text);
  const took = Date.now() - t0;
  if (out.ok) { console.log(`  попытка ${i}: ✅ получилось за ${took} мс`); break; }
  const again = TRANSIENT.has(out.cause);
  console.log(`  попытка ${i}: ${out.cause} (${out.stage}) за ${took} мс — ${again ? 'сбой доставки, повторяю' : 'ЭТО ОТВЕТ, а не сбой: повтор купит то же самое, останавливаюсь'}`);
  if (!again) break;
  await new Promise((r) => setTimeout(r, 1500 * i));
}

console.log('\n' + JSON.stringify(out, null, 2).slice(0, 2000));

// Пауза перед сверкой: платёж оседает не мгновенно.
await new Promise((r) => setTimeout(r, 6000));
const after = await bal();
console.log(`\n  списано за прогон: ${formatUnits(before - after, 6)} USDC`);
console.log(`  остаток          : ${formatUnits(after, 6)} USDC (${Math.floor(Number(formatUnits(after, 6)) / 0.01)} запросов)`);
