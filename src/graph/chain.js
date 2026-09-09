// The step the enclave CANNOT take.
//
// Recovering the signer gives an allocation ID, not an indexer. Turning one into
// the other is an on-chain call, and an enclave has no network — so this runs on
// the producing side, and its RESULT travels inside our signed snapshot as a
// statement of authority we take responsibility for.
//
// 🔴 Both addresses below moved with the Horizon upgrade. Anything pinned here needs
// a watcher comparing it against the live address book, alarming in a way that is
// distinguishable from a policy refusal — otherwise a protocol migration reads as
// "signature did not verify" and nobody goes looking.

import { createPublicClient, http } from 'viem';
import { arbitrum, mainnet } from 'viem/chains';
import { GRAPH_NETWORK } from './attestation.js';

const SUBGRAPH_SERVICE_ABI = [
  {
    name: 'getAllocation',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'allocationId', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'indexer', type: 'address' },
          { name: 'subgraphDeploymentId', type: 'bytes32' },
          { name: 'tokens', type: 'uint256' },
          { name: 'createdAt', type: 'uint256' },
          { name: 'closedAt', type: 'uint256' },
          { name: 'accRewardsPerAllocatedToken', type: 'uint256' },
          { name: 'accRewardsPending', type: 'uint256' },
          { name: 'createdAtEpoch', type: 'uint256' },
        ],
      },
    ],
  },
];

export function arbitrumClient(rpcUrl = 'https://arbitrum-one-rpc.publicnode.com') {
  return createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });
}

export function mainnetClient(rpcUrl = 'https://ethereum-rpc.publicnode.com') {
  return createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
}

/** Current Ethereum head — the yardstick for source freshness. Free, no key. */
export async function chainHead(client = mainnetClient()) {
  return client.getBlockNumber();
}

/**
 * Resolve an allocation ID to the indexer behind it, and check the allocation is
 * for the deployment the attestation claims.
 *
 * A mismatch here is the interesting case: a valid signature over the right bytes
 * from a key allocated to a DIFFERENT subgraph.
 */
export async function resolveIndexer(allocationId, expectedDeploymentId, client = arbitrumClient()) {
  let alloc;
  try {
    alloc = await client.readContract({
      address: GRAPH_NETWORK.subgraphService,
      abi: SUBGRAPH_SERVICE_ABI,
      functionName: 'getAllocation',
      args: [allocationId],
    });
  } catch (err) {
    // Reverting is not "no allocation" — it may equally mean the contract moved
    // again. Reported as its own outcome so a migration cannot be mistaken for a
    // rejected attestation.
    return { ok: false, reason: 'allocation_lookup_failed', detail: String(err?.shortMessage ?? err) };
  }

  if (!alloc || alloc.indexer === '0x0000000000000000000000000000000000000000') {
    return { ok: false, reason: 'no_allocation_for_signer', detail: { allocationId } };
  }
  if (
    expectedDeploymentId &&
    alloc.subgraphDeploymentId?.toLowerCase() !== expectedDeploymentId.toLowerCase()
  ) {
    return {
      ok: false,
      reason: 'allocation_deployment_mismatch',
      detail: { allocation: alloc.subgraphDeploymentId, attestation: expectedDeploymentId },
    };
  }

  return {
    ok: true,
    indexer: alloc.indexer,
    stakedTokens: alloc.tokens.toString(),
    subgraphDeploymentId: alloc.subgraphDeploymentId,
  };
}
