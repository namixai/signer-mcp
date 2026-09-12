// Verification of The Graph's indexer attestation.
//
// What this proves and what it does NOT:
//   - proves: the signature binds THESE EXACT BYTES to this subgraph deployment,
//     and recovers the address that signed (the allocation ID).
//   - does NOT prove: that the signer is a staked indexer. That needs an on-chain
//     lookup (see chain.js) which an enclave cannot do. See the spec's trust-boundary
//     decision: the attestation is an artefact for third-party re-checking, never a
//     trust anchor inside the enclave.

import { keccak256, encodeAbiParameters, stringToBytes, toBytes, recoverAddress } from 'viem';

// EIP-712 constants, read from graphprotocol/contracts DisputeManager.sol.
const DOMAIN_TYPE_HASH = keccak256(
  toBytes(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)',
  ),
);
const DOMAIN_NAME_HASH = keccak256(toBytes('Graph Protocol'));
const DOMAIN_VERSION_HASH = keccak256(toBytes('0'));
const DOMAIN_SALT =
  '0xa070ffb1cd7409649bf77822cce74495468e06dbfaef09556838bf188679b9c2';
const RECEIPT_TYPE_HASH = keccak256(
  toBytes(
    'Receipt(bytes32 requestCID,bytes32 responseCID,bytes32 subgraphDeploymentID)',
  ),
);

// The Graph on Arbitrum One after the Horizon upgrade.
//
// 🔴 This address MOVED with Horizon: the pre-Horizon DisputeManager is now
// `LegacyDisputeManager`, and using it recovers an address with no allocation
// behind it — a silent wrong answer, not an error. Anything pinned here needs
// a watcher that compares it against the live address book, and the alarm must
// be distinguishable from a policy refusal.
export const GRAPH_NETWORK = {
  chainId: 42161,
  disputeManager: '0x2FE023a575449AcB698648eD21276293Fa176f96',
  subgraphService: '0xb2Bb92d0DE618878E438b55D5846cfecD9301105',
};

export function domainSeparator(network = GRAPH_NETWORK) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'bytes32' },
      ],
      [
        DOMAIN_TYPE_HASH,
        DOMAIN_NAME_HASH,
        DOMAIN_VERSION_HASH,
        BigInt(network.chainId),
        network.disputeManager,
        DOMAIN_SALT,
      ],
    ),
  );
}

export function receiptDigest(attestation, network = GRAPH_NETWORK) {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [
        RECEIPT_TYPE_HASH,
        attestation.requestCID,
        attestation.responseCID,
        attestation.subgraphDeploymentID,
      ],
    ),
  );
  return keccak256(`0x1901${domainSeparator(network).slice(2)}${structHash.slice(2)}`);
}

// The gateway sends `v` RAW (0/1), not 27/28.
//
// Measured, not assumed: viem's recoverAddress already treats 0 as 27 and 1 as 28,
// so for the values that actually arrive this normalisation is a NO-OP today. It is
// kept as portability armour — a different crypto library may not be so forgiving —
// and for the bogus-value guard below, which is load-bearing.
//
// An earlier comment here claimed normalising was "the difference between recovering
// the real signer and recovering a stranger". That was false for viem, and a planted
// defect proved it: removing the +27 left every test green. Fixed rather than left as
// a green line that tests nothing.
export function normaliseV(v) {
  // Number(null) === 0, Number(false) === 0, Number('') === 0, Number([]) === 0.
  // Coercing first would turn every one of those into a confident 27.
  if (typeof v !== 'number' && typeof v !== 'bigint' && typeof v !== 'string') {
    throw new Error(`recovery id must be a number, bigint or numeric string, got ${typeof v}`);
  }
  // '' also passes the typeof check above, and Number('') === 0 — so a blank string
  // would still have become a confident 27. Caught by the test written for this fix.
  if (typeof v === 'string' && !/^\s*\d+\s*$/.test(v)) {
    throw new Error(`recovery id string is not a decimal integer: ${JSON.stringify(v)}`);
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`recovery id is not an integer: ${String(v)}`);
  if (n === 0 || n === 1) return n + 27;
  if (n === 27 || n === 28) return n;
  throw new Error(`unsupported recovery id: ${String(v)}`);
}

/**
 * Verify an attestation against the exact response bytes.
 *
 * `rawBody` MUST be the bytes as they arrived. Re-serialising the JSON (key order,
 * whitespace) changes the hash and the check fails for the wrong reason.
 *
 * `requestCID` is deliberately NOT checked: its preimage is unknown to us — four
 * plausible encodings of a known query all failed to reproduce it. Claiming a check
 * we cannot perform would be a ritual, not a guarantee.
 */
export async function verifyAttestation(rawBody, attestation, network = GRAPH_NETWORK) {
  // The raw/parsed distinction is the most fragile thing in this file: a parsed
  // object re-serialised on the way in hashes to something else entirely. Refuse
  // it by name rather than letting viem throw from three frames down.
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    return {
      ok: false,
      reason: 'raw_body_required',
      detail: { got: rawBody === null ? 'null' : typeof rawBody },
    };
  }
  // 🔴 stringToBytes, НЕ toBytes. `toBytes` угадывает по виду значения: строку, похожую на
  // hex, оно ДЕКОДИРУЕТ вместо того чтобы хешировать её текст, а Uint8Array прогоняет через
  // приведение к строке. Замерено на viem 2.56.3: toBytes('0xdeadbeef') даёт 4 байта вместо
  // 10, а toBytes(Uint8Array[1,2,3]) — 5 вместо 3.
  //
  // responseCID считается по ТОЧНЫМ байтам ответа, и догадка о типе — последнее, что здесь
  // нужно. Тело обязано быть строкой (проверено выше) и кодируется как текст, явно.
  // 🔴 И ВЕТКА ПО ТИПУ. Функция объявляет, что принимает Uint8Array, и до этой правки
  // прогоняла его через stringToBytes — то есть хешировала текстовое представление
  // массива, а не сами байты. Замер: одно и то же тело строкой проходит, байтами даёт
  // `response_cid_mismatch`. Опаснее всего то, ЧТО именно ломалось: сверка подписи
  // индексера начинала проверять не то, что пришло, и молча объявляла годный ответ
  // подделанным. Найдено ревью CodeRabbit на signer-mcp#19.
  // 🔴 И САМА АТТЕСТАЦИЯ ПРОВЕРЯЕТСЯ НА ФОРМУ — ДО ПЕРВОГО ОБРАЩЕНИЯ К ПОЛЮ. Замерено
  // 12.09: `verifyAttestation('{}', null)` и то же с `undefined` БРОСАЛИ TypeError
  // «Cannot read properties of null (reading 'responseCID')». Весь файл объявляет, что
  // отказывает по имени и не бросает никогда; на пустом входе это было неправдой, и
  // ломается такое первым — пустое значение приходит из `JSON.parse` чужого ответа
  // ровно так же легко, как испорченная подпись.
  //
  // Отдельно `responseCID`: без этой проверки `{}` отказывал как `response_cid_mismatch`
  // с `claimed: undefined`. Формально верно, по смыслу — мимо: читатель идёт сверять
  // байты ответа, тогда как аттестации не было вовсе. Разные болезни, разные лечения.
  if (attestation === null || typeof attestation !== 'object' || Array.isArray(attestation)) {
    return {
      ok: false,
      reason: 'attestation_required',
      detail: { got: attestation === null ? 'null' : Array.isArray(attestation) ? 'array' : typeof attestation },
    };
  }
  if (typeof attestation.responseCID !== 'string') {
    return {
      ok: false,
      reason: 'attestation_required',
      detail: {
        note: 'no responseCID to compare against; this is a missing attestation, not a digest disagreement',
        field: 'responseCID',
        type: typeof attestation.responseCID,
      },
    };
  }
  const computed = keccak256(typeof rawBody === 'string' ? stringToBytes(rawBody) : rawBody);
  if (computed !== attestation.responseCID) {
    return {
      ok: false,
      reason: 'response_cid_mismatch',
      detail: { computed, claimed: attestation.responseCID },
    };
  }

  // 🔴 КРИВАЯ ПОДПИСЬ — ЭТО ОТКАЗ ПО ИМЕНИ, А НЕ ПАДЕНИЕ. Всё, что выше, отказывало
  // аккуратно, а этот блок бросал: посторонний, проходивший поверхность 12.09, ломал
  // подпись руками — и видел стектрейс вместо нашего отказа. Замер: из одиннадцати
  // рукотворных порч ВОСЕМЬ бросали — не-hex символ, отсутствие `0x`, пустая строка,
  // нули, двойная длина, отсутствующее поле, мусорный и строковый `v`.
  //
  // Именно здесь это дороже всего: у нас семьдесят два кода отказа и отдельный словарь,
  // отличающий «ответа нет» от «не смог спросить», и всё это обесценивается одним
  // стектрейсом на том шаге, который судья ломает первым.
  //
  // 🔴 И сообщение библиотеки НЕ ПЕРЕДАЁТСЯ НАРУЖУ: viem печатает отвергнутый скаляр
  // целиком, то есть испорченную подпись — ровно та же утечка через путь ошибки, что
  // была с ключом RP. Наружу идёт имя поля, длина и ничего больше.
  const shape = (name, v) => ({
    field: name,
    type: typeof v,
    length: typeof v === 'string' ? v.length : null,
    hex: typeof v === 'string' ? /^0x[0-9a-fA-F]*$/.test(v) : false,
  });

  // 🔴 ДВА ЭТАПА, И ОТКАЗ ОБЯЗАН НАЗВАТЬ СВОЙ. До правки дайджест и восстановление
  // подписи стояли в одном try. Замерено 12.09: испорченный `requestCID` (или
  // `subgraphDeploymentID`) роняет encodeAbiParameters ДО всякой подписи, а наружу
  // уходило `note: 'signature could not be read'` и форма r/s/v — все три идеальные,
  // length 66, hex true. То есть отказ показывал пальцем на здоровую подпись, пока
  // ломался совсем другой вход. Диагноз, уводящий в сторону, дороже стектрейса: по
  // стектрейсу видно хотя бы строку, а по неверному имени этапа чинят не то.
  // 🔴 И ФОРМА ВХОДОВ ДАЙДЖЕСТА ПРОВЕРЯЕТСЯ ДО БИБЛИОТЕКИ. Замерено 12.09 на viem
  // 2.56.3: `encodeAbiParameters` для bytes32 сверяет РАЗМЕР, а не алфавит. `0x` плюс
  // 64 буквы «Z» проходят насквозь, дают дайджест и восстанавливают ПОСТОРОННЕГО
  // подписанта — verifyAttestation возвращала ok:true на вход, который не является hex.
  // Слоистость это ловила (у такого подписанта нет аллокации в цепи), но диагноз
  // «годная аттестация неизвестного подписанта» уводит в сторону сильнее, чем
  // «ваш CID не hex».
  //
  // Чего проверка НЕ делает, чтобы её не переоценили: `0x` с 64 нулями — законный hex,
  // он проходит и восстанавливает другого подписанта. Это верно, и отсекает его цепь,
  // а не форма.
  const HEX32 = /^0x[0-9a-fA-F]{64}$/;
  let digest;
  const badShape = ['requestCID', 'subgraphDeploymentID'].filter(
    (f) => !HEX32.test(attestation?.[f] ?? ''),
  );
  if (badShape.length > 0) {
    return {
      ok: false,
      reason: 'attestation_unusable',
      detail: {
        stage: 'digest',
        fields: ['requestCID', 'responseCID', 'subgraphDeploymentID'].map((f) =>
          shape(f, attestation?.[f]),
        ),
        note: 'a digest input is not a 32-byte hex string; the library message is withheld because it quotes values back',
      },
    };
  }
  try {
    digest = receiptDigest(attestation, network);
  } catch {
    return {
      ok: false,
      reason: 'attestation_unusable',
      detail: {
        stage: 'digest',
        // `responseCID` сверен ВЫШЕ и досюда негодным не доходит; он здесь потому, что
        // входит в дайджест, и картина входа должна быть полной.
        fields: ['requestCID', 'responseCID', 'subgraphDeploymentID'].map((f) =>
          shape(f, attestation[f]),
        ),
        note: 'the receipt digest could not be built from these fields; the library message is withheld because it quotes values back',
      },
    };
  }

  let allocationId;
  try {
    allocationId = await recoverAddress({
      hash: digest,
      signature: {
        r: attestation.r,
        s: attestation.s,
        v: BigInt(normaliseV(attestation.v)),
      },
    });
  } catch {
    return {
      ok: false,
      reason: 'attestation_unusable',
      // Что не сошлось — по форме полей, без их значений.
      detail: {
        stage: 'signature',
        fields: ['r', 's', 'v'].map((f) => shape(f, attestation[f])),
        note: 'signature could not be read; the library message is withheld because it quotes the value back',
      },
    };
  }

  return {
    ok: true,
    responseCID: computed,
    digest,
    allocationId,
    subgraphDeploymentID: attestation.subgraphDeploymentID,
    // Stated so no caller mistakes this for proof of a staked indexer.
    proves: 'these exact bytes were signed by the holder of this key',
    doesNotProve: 'that the key belongs to a staked indexer (needs chain lookup)',
  };
}

export function parseAttestationHeader(headerValue) {
  const a = typeof headerValue === 'string' ? JSON.parse(headerValue) : headerValue;
  // JSON.parse('null') is null, and a null header would otherwise blow up on the
  // first field access instead of saying what is wrong.
  if (a === null || typeof a !== 'object' || Array.isArray(a)) {
    throw new Error(`attestation header must be a JSON object, got ${a === null ? 'null' : typeof a}`);
  }
  for (const field of ['requestCID', 'responseCID', 'subgraphDeploymentID', 'r', 's', 'v']) {
    // `== null`, не `=== undefined`: {"v": null} проходил, и дальше normaliseV бросал
    // сообщение о типе из нижнего кадра, а null в r/s доезжал до viem. Тот же капкан
    // записан в fetch.js — null !== undefined, и проверка на одно пропускает другое.
    if (a[field] == null) throw new Error(`attestation missing field: ${field}`);
  }
  return a;
}
