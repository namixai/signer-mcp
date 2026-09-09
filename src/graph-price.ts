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

import { paidQuery } from "./graph/fetch.js";
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
  symbol: string;
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
function refuse(stage: Stage, cause: string, detail: unknown = null): ToolResult {
  return toolJson({
    ok: false,
    stage,
    cause,
    detail: detail ?? null,
    checked: false,
    note:
      "No price is returned. A refusal here is a decision, not an outage — read `cause` " +
      "before retrying, because these are not fixed the same way.",
  });
}

export async function handleGetVerifiedPrice(
  args: VerifiedPriceInput,
  deps: PriceDeps = REAL_DEPS,
): Promise<ToolResult> {
  const symbol = args?.symbol;
  if (typeof symbol !== "string" || symbol === "") {
    return refuse("query", "bad_request", "symbol is required");
  }
  const timings: Record<string, number> = {};

  // 1. The paid read. paidQuery refuses `no_payer_key` by name when X402_PRIVATE_KEY
  //    is unset — deliberately NOT re-implemented here. This tool never invents a
  //    payer: if the operator has not set a key, nothing is spent and nothing is faked.
  let t = ms();
  const q: any = await deps.paidQuery(
    args.subgraph_id ? { subgraphId: args.subgraph_id } : {},
  );
  timings.query_ms = ms() - t;
  if (!q?.ok) return refuse("query", String(q?.reason ?? "query_failed"), q?.detail);

  // 2. The signature over the bytes AS THEY ARRIVED. Re-serialising the JSON first
  //    changes the hash, so the raw body travels untouched from fetch to here.
  t = ms();
  const attestation = deps.parseAttestationHeader(q.attestationHeader);
  const verification: any = await deps.verifyAttestation(q.rawBody, attestation);
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
  const usability: any = deps.checkUsable(parsed, symbol, head);
  timings.usability_ms = ms() - t;
  if (!usability?.ok) {
    return refuse("usability", String(usability?.reason ?? "not_usable"), usability?.detail);
  }

  // 6. The answer, which states what was NOT checked as plainly as what was.
  const observedAtMs = ms();
  const snap: any = deps.buildSnapshot({
    subgraphId: q.subgraphId ?? args.subgraph_id,
    symbol,
    verification,
    usability,
    indexer,
    chainHead: head,
    observedAtMs,
    blockTimestampMs: observedAtMs,
    ...(typeof args.band_bps === "number" ? { bandBps: args.band_bps } : {}),
  });
  if (!snap?.ok) {
    return refuse("snapshot", String(snap?.refusal?.reason ?? "snapshot_refused"), snap?.refusal?.detail);
  }

  return toolJson({
    ok: true,
    snapshot: snap.snapshot,
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
  });
}
