// Piece C: assembling the canonical snapshot, and the rule that follows from it.
//
// WHAT THIS IS FOR. The checks in attestation.js and usability.js establish facts about a
// market reading. On their own they are a report nobody can act on. This turns them into
// (a) a signable object that states what we checked and what we could not, and (b) a rule
// that decides — because "meaningful work with the data" means a decision, not a print.
//
// 🔴 WHAT IT IS NOT. The enclave does not parse this. There is no enclave action that
// verifies a signed snapshot and applies a band, and building one was ruled out for this
// window. So the honest claim is "the price was checked BEFORE a signature was requested",
// never "market data is an input to enclave policy". The band below is computed out here,
// by us, and we sign our own statement that we computed it.
//
// FORMAT RULES, INHERITED RATHER THAN INVENTED. They come from two of our internal design
// documents (an attested-snapshot payload contract and a 2026-08-04 design for signed data
// as a policy input). Those are NOT published, so rather than cite a path a reader cannot
// open, the rules that matter are stated here in full:
//   · the enclave owns canonicalisation and signing; we send `data` to /sign-data and the
//     buyer's recipe is keccak256(b"usenami-attested-data-v1" ‖ canonical_v1(data)).
//     We do NOT write our own canonicaliser — two recipes under one product name is the
//     defect that would outlive the hackathon.
//   · EVERY numeric is a decimal string. canonical_v1 rejects JSON numbers outright, and
//     float canonicalisation is where independent implementations diverge.
//   · a refusal is an ARTIFACT, not a skip: "we have no reading" must not be
//     indistinguishable from "we refuse to attest this reading, and here is why".
//   · the enclave's payload limit is 32768 bytes; we stay well under it so the door to a
//     future enclave action is not closed by size.

export const SNAPSHOT_SCHEMA = 'usenami.market-reference.dex.v1';
export const MAX_PAYLOAD_BYTES = 32_768;

/** Default band half-width in basis points. Deliberately WIDE — see judgeOrder. */
export const DEFAULT_BAND_BPS = 500n; // 5%

const isDecimalString = (s) => typeof s === 'string' && /^\d+(\.\d+)?$/.test(s);

/**
 * Assemble the snapshot. Pure: every input is passed in, nothing is read from the clock or
 * the network here, so the same inputs always produce the same bytes.
 */
export function buildSnapshot({
  subgraphId,
  symbol,
  verification,
  usability,
  indexer,
  chainHead,
  observedAtMs,
  blockTimestampMs,
  bandBps = DEFAULT_BAND_BPS,
} = {}) {
  const refuse = (reason, detail) => ({
    ok: false,
    refusal: {
      schema: SNAPSHOT_SCHEMA,
      kind: 'refusal',
      reason,
      detail: detail == null ? null : detail,
      subgraph_id: subgraphId ?? null,
      symbol: symbol ?? null,
      // 🔴 `== null`, не `=== undefined`: явный null проходил и печатался СТРОКОЙ "null"
      // внутри отказа — того самого артефакта, который мы предлагаем перепроверить.
      // Ровно та же форма, что я чинил в квитанции гейта; здесь она на подписываемом
      // объекте, и найдена ревью, а не мной.
      observed_at_ms: observedAtMs == null ? null : String(observedAtMs),
    },
  });

  if (!subgraphId || typeof subgraphId !== 'string') return refuse('bad_request', 'subgraphId missing');
  if (!symbol || typeof symbol !== 'string') return refuse('bad_request', 'symbol missing');
  if (typeof observedAtMs !== 'number' || !Number.isFinite(observedAtMs)) {
    return refuse('bad_request', 'observedAtMs must be a finite number');
  }

  // The three checks, in the order the spec fixes them. Each failure is its own artifact,
  // carrying the reason the check gave rather than a generic "unusable".
  if (!verification || verification.ok !== true) {
    return refuse('attestation_not_verified', verification?.reason ?? null);
  }
  if (!usability || usability.ok !== true) {
    return refuse('reading_not_usable', usability?.reason ?? null);
  }
  if (!indexer || indexer.ok !== true) {
    return refuse('indexer_not_resolved', indexer?.reason ?? null);
  }
  if (!isDecimalString(usability.priceUSD)) {
    return refuse('price_not_decimal_string', String(usability.priceUSD));
  }

  // 🔴 THE FIELDS MUST EXIST, not default to "". `source_block` shipped EMPTY in the
  // signed artifact for a day: the code read `usability.sourceBlock` while checkUsable
  // returns `metaBlock`, and `?? ''` swallowed the mismatch. An empty field in an object
  // we invite a stranger to re-verify is worse than a missing one — it looks answered.
  //
  // And no test caught it, because the fixture fed the name the code expected. The test
  // agreed with the code instead of with checkUsable. Hence the check here AND a test
  // that builds its input from the real checkUsable output.
  for (const [k, v] of [['metaBlock', usability.metaBlock], ['priceBlock', usability.priceBlock], ['chainHead', chainHead]]) {
    if (v == null || v === '') return refuse('missing_block_number', k);
  }

  // 🔴 AND EVERY OTHER FIELD THAT ENTERS THE SIGNATURE, because JSON.stringify DROPS a key
  // whose value is undefined. Not empty — GONE. A caller who misspells a field (and callers
  // hand-write these objects) produces signed bytes with the authority statement simply
  // absent, and nothing anywhere says so.
  //
  // Same defect as `source_block` two commits ago, one field over: I fixed the instance and
  // not the class, so it came back. Measured — with `indexerAddress` instead of `indexer`,
  // `source.indexer` was missing from dataText entirely, as was `checked.response_bytes_hash`.
  for (const [k, v] of [
    ['indexer', indexer.indexer],
    ['allocationId', verification.allocationId],
    ['subgraphDeploymentID', verification.subgraphDeploymentID],
    ['responseCID', verification.responseCID],
  ]) {
    if (typeof v !== 'string' || v === '') return refuse('missing_authority_field', k);
  }

  // 🔴 A READING CANNOT BE OBSERVED BEFORE THE BLOCK IT REPORTS. This is not a tolerance
  // knob, it is arithmetic: the snapshot carried observed_at_ms of 2025-09-04 against a
  // block stamped 2026-09-04 — a year early — and shipped signed. For an artifact whose
  // whole value is two ages, a wrong third time is a defect of substance.
  if (blockTimestampMs != null) {
    if (typeof blockTimestampMs !== 'number' || !Number.isFinite(blockTimestampMs)) {
      return refuse('bad_request', 'blockTimestampMs must be a finite number');
    }
    if (observedAtMs < blockTimestampMs) {
      return refuse('observed_before_block', { observedAtMs, blockTimestampMs });
    }
  }

  const band = bandFor(usability.priceUSD, bandBps);
  if (!band) return refuse('band_not_computable', String(usability.priceUSD));

  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    kind: 'market_reference',
    source: {
      provider: 'thegraph',
      subgraph_id: subgraphId,
      // The indexer that served it and the allocation the signature recovered to. This is
      // the part the enclave could never establish for itself: it needs the chain.
      indexer: indexer.indexer,
      allocation_id: verification.allocationId,
      subgraph_deployment_id: verification.subgraphDeploymentID,
    },
    reading: {
      symbol,
      price_usd: usability.priceUSD,
      // Two ages, kept apart on purpose: a fresh subgraph head does not make the price
      // fresh, because prices are written inside event handlers.
      source_block: String(usability.metaBlock),
      price_block: String(usability.priceBlock),
      chain_head: String(chainHead),
      block_timestamp_ms: blockTimestampMs == null ? null : String(blockTimestampMs),
    },
    band: {
      basis_points: String(bandBps),
      low_usd: band.low,
      high_usd: band.high,
    },
    checked: {
      response_bytes_hash: verification.responseCID,
      attestation_signature: 'verified',
      indexer_allocation: 'resolved_on_chain',
      usability: 'passed',
    },
    // 🔴 Stated in the artifact itself, not only in a README. A reader who trusts this
    // object should be able to see its holes without reading our prose.
    not_checked: {
      request_cid: 'preimage unknown to us; four plausible encodings of the known query did not reproduce it',
      indexer_correctness: 'an attestation proves who served the bytes, not that the number is right',
    },
    observed_at_ms: String(observedAtMs),
  };

  const dataText = JSON.stringify(snapshot);
  // TextEncoder, не Buffer: пакет открывают судьи, и привязывать его к Node незачем.
  // Тот же довод уже записан в fetch.js — и там я его применил, а здесь нарушил.
  const bytes = new TextEncoder().encode(dataText).length;
  if (bytes > MAX_PAYLOAD_BYTES) {
    return refuse('payload_too_large', { bytes, limit: MAX_PAYLOAD_BYTES });
  }

  // 🔴 `dataText` is what gets signed, VERBATIM. Re-serialising the object later produces
  // different bytes for the same value, the buyer's recomputation fails, and everything
  // still looks fine — contract rule 4.1, and the same lesson as responseCID.
  return { ok: true, snapshot, dataText, bytes };
}

/** Band bounds as decimal strings, computed in integer arithmetic to avoid float drift. */
export function bandFor(priceUSD, bandBps = DEFAULT_BAND_BPS) {
  if (!isDecimalString(priceUSD)) return null;
  const [whole, frac = ''] = priceUSD.split('.');
  const scale = frac.length;
  const asInt = BigInt(whole + frac);
  const bps = BigInt(bandBps);
  if (bps < 0n || bps >= 10_000n) return null;
  const low = (asInt * (10_000n - bps)) / 10_000n;
  const high = (asInt * (10_000n + bps)) / 10_000n;
  const back = (v) => {
    const s = v.toString().padStart(scale + 1, '0');
    return scale === 0 ? s : `${s.slice(0, -scale)}.${s.slice(-scale)}`;
  };
  return { low: back(low), high: back(high) };
}

/**
 * The rule. Given a signed snapshot and the price an order would execute at, decide.
 *
 * 🔴 THE BAND IS DELIBERATELY WIDE, and that is the design, not a weakness. A tight band
 * would refuse honest orders during ordinary volatility, and a check that fires on
 * legitimate traffic gets switched off. This catches the case it was built for: an agent
 * signing at a price with no relationship to the market — a stale quote, a manipulated
 * route, a fat finger. Not "did we get the best price"; nothing here promises that.
 */
export function judgeOrder(snapshot, orderPriceUSD) {
  if (!snapshot || snapshot.kind !== 'market_reference') {
    return { ok: false, reason: 'not_a_market_reference' };
  }
  if (!isDecimalString(orderPriceUSD)) {
    return { ok: false, reason: 'order_price_not_decimal_string', detail: String(orderPriceUSD) };
  }
  const cmp = (a, b) => {
    const scale = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0);
    const norm = (s) => {
      const [w, f = ''] = s.split('.');
      return BigInt(w + f.padEnd(scale, '0'));
    };
    const x = norm(a), y = norm(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  if (cmp(orderPriceUSD, snapshot.band.low_usd) < 0) {
    return { ok: true, allowed: false, reason: 'below_band', band: snapshot.band };
  }
  if (cmp(orderPriceUSD, snapshot.band.high_usd) > 0) {
    return { ok: true, allowed: false, reason: 'above_band', band: snapshot.band };
  }
  return { ok: true, allowed: true, band: snapshot.band };
}
