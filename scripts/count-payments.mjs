#!/usr/bin/env node
// Сколько на самом деле списано, по цепи, а не вычитанием из памяти.
//
// 🔴 БАЛАНС СРАЗУ ПОСЛЕ СЕРИИ ЗАПРОСОВ НЕДОСЧИТЫВАЕТ. Проверено 10.09: после четырёх
// платежей подряд четвёртый ещё не осел, я прочитал баланс и объявил расход на цент
// меньше настоящего. Считать надо переводы, а не разницу, и давать осесть.
//
// RPC Base ограничивает eth_getLogs двумя тысячами блоков за запрос, поэтому окнами.

import { createPublicClient, http, formatUnits, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
const c = createPublicClient({ chain: base, transport: http() });
const me = '0xCf3E005a83Cc77E66e8544e3D6DD0340ea305ba9';
const head = await c.getBlockNumber();
// RPC Base ограничивает eth_getLogs двумя тысячами блоков — иду окнами, а не одним куском.
const ev = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const logs = [];
for (let i = 0n; i < 6n; i++) {
  const to = head - i * 2000n;
  const from = to - 1999n;
  logs.push(...await c.getLogs({ address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', event: ev, args: { from: me }, fromBlock: from, toBlock: to }));
}
logs.sort((a, b) => Number(a.blockNumber - b.blockNumber));
console.log('платежей с этого адреса:', logs.length);
let sum = 0n;
for (const l of logs) {
  sum += l.args.value;
  const b = await c.getBlock({ blockNumber: l.blockNumber });
  const t = new Date(Number(b.timestamp) * 1000).toISOString().slice(11, 19);
  console.log(`  ${t} UTC  ${formatUnits(l.args.value, 6)} USDC  блок ${l.blockNumber}  tx ${l.transactionHash.slice(0, 14)}…`);
}
console.log('итого списано:', formatUnits(sum, 6), 'USDC');
