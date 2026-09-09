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
  const computed = keccak256(stringToBytes(rawBody));
  if (computed !== attestation.responseCID) {
    return {
      ok: false,
      reason: 'response_cid_mismatch',
      detail: { computed, claimed: attestation.responseCID },
    };
  }

  const digest = receiptDigest(attestation, network);
  const allocationId = await recoverAddress({
    hash: digest,
    signature: {
      r: attestation.r,
      s: attestation.s,
      v: BigInt(normaliseV(attestation.v)),
    },
  });

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
