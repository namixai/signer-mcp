export interface IndexerResult { ok: boolean; reason?: string; detail?: unknown; indexer?: string; }
export function arbitrumClient(rpcUrl?: string): unknown;
export function mainnetClient(rpcUrl?: string): unknown;
export function chainHead(client?: unknown): Promise<bigint>;
export function resolveIndexer(allocationId: string | undefined, expectedDeploymentId: string | undefined, client?: unknown): Promise<IndexerResult>;
