#!/usr/bin/env node
// Один платный запрос, измеренный, с ценой показанной ДО подписи.
//
//   X402_PRIVATE_KEY="$(cat)" node scripts/paid-measure.mjs
//   (вставить ключ, нажать Ctrl-D)
//
// 🔴 Ключ читается из окружения, заполненного через $(cat): он не попадает ни в историю
// оболочки, ни в аргументы процесса, ни в вывод. Скрипт его НЕ печатает и НЕ сохраняет.
// Печатается только адрес плательщика — адрес это не ключ.
//
// 🔴 ДО списания скрипт останавливается и ждёт подтверждения с терминала. Всё, что выше
// паузы, бесплатно: чтение баланса и цены — обычные вызовы, ничего не подписывающие.

import { handleGetVerifiedPrice } from '../dist/graph-price.js';
import { createPublicClient, http, erc20Abi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { quote } from '../dist/graph/fetch.js';
import { openSync, readSync, closeSync } from 'node:fs';

const key = process.env.X402_PRIVATE_KEY;
if (!key) {
  console.error('X402_PRIVATE_KEY пуст. Запускать так:\n  X402_PRIVATE_KEY="$(cat)" node scripts/paid-measure.mjs');
  process.exit(2);
}

let account;
try {
  account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
} catch {
  // Намеренно без подробностей: сообщение об ошибке от библиотеки несёт сам ключ.
  console.error('Ключ не разобран. Ожидается 64 hex-символа, с 0x или без. Ключ не печатаю.');
  process.exit(2);
}

const client = createPublicClient({ chain: base, transport: http() });
const q = await quote();
if (!q?.ok) { console.error('Шлюз не отдал цену:', q?.reason ?? q); process.exit(2); }

const [dec, sym] = await Promise.all([
  client.readContract({ address: q.asset, abi: erc20Abi, functionName: 'decimals' }),
  client.readContract({ address: q.asset, abi: erc20Abi, functionName: 'symbol' }),
]);
const balance = await client.readContract({
  address: q.asset, abi: erc20Abi, functionName: 'balanceOf', args: [account.address],
});
const price = formatUnits(BigInt(q.amountAtomic), dec);

console.log(`
  ПЛАТИТ        ${account.address}
  баланс        ${formatUnits(balance, dec)} ${sym}
  СПИСАНИЕ      ${price} ${sym}
  получатель    ${q.payTo}
  сеть          Base (chainId 8453), способ ${q.transferMethod}
  остаток после ${formatUnits(balance - BigInt(q.amountAtomic), dec)} ${sym}
`);

if (balance < BigInt(q.amountAtomic)) {
  console.error('Баланса не хватает на один запрос. Ничего не списано, выхожу.');
  process.exit(2);
}

process.stderr.write('Списать эту сумму? Enter — да, Ctrl-C — нет: ');
const tty = openSync('/dev/tty', 'r');
const buf = Buffer.alloc(64);
const n = readSync(tty, buf, 0, 64, null);
closeSync(tty);
// 🔴 Раньше годился ЛЮБОЙ ввод: «no», «стоп» и случайная клавиша одинаково означали
// «да». Согласие — это пустая строка (просто Enter) или явное y/yes; всё прочее отказ.
const answer = buf.slice(0, n).toString('utf8').trim().toLowerCase();
if (answer !== '' && answer !== 'y' && answer !== 'yes') {
  console.error(`
Понято как отказ: ${JSON.stringify(answer)}. Ничего не списано.`);
  process.exit(2);
}

const t0 = Date.now();
// Без символа: запрос возвращает пятёрку с самой свежей ценой, и какие это токены —
// заранее не знает никто. Первый платный прогон спросил WETH, не угадал и потратил цент
// впустую. Спрашиваем всё, что пришло; SYMBOL можно задать, если нужен конкретный.
const res = await handleGetVerifiedPrice(process.env.SYMBOL ? { symbol: process.env.SYMBOL } : {});
const total = Date.now() - t0;
const out = JSON.parse(res.content[0].text);

console.log('\n' + JSON.stringify(out, null, 2));
console.log(`\n  ВЕСЬ ПРОХОД   ${total} мс`);
if (out.ok) {
  console.log('  доступно было   :', (out.available ?? []).join(', '));
  console.log('  прошло проверку :', (out.priced ?? []).map((x) => `${x.symbol} ${x.price_usd}`).join(' | '));
  if (out.refused?.length) console.log('  отвергнуто      :', out.refused.map((x) => `${x.symbol}: ${x.reason}`).join(' | '));
  console.log('  четыре проверки:');
  console.log('    подпись по точным байтам :', out.checks.attestation_verified_over_raw_bytes);
  console.log('    индексатор ончейн        :', out.checks.indexer_resolved_on_chain);
  console.log('    годность чтения          :', out.checks.reading_usable);
  console.log('    возраст цены отдельно    :', JSON.stringify(out.checks.price_age_measured_separately));
} else {
  console.log(`  ОТКАЗ: stage=${out.stage} cause=${out.cause}`);
  console.log('  🔴 Если cause = paid_request_failed — списание МОГЛО пройти. Смотреть на цепи.');
}
console.log(`\n  платежи этого адреса: https://basescan.org/address/${account.address}#tokentxns`);
