export interface UsabilityResult {
  ok: boolean; reason?: string; detail?: unknown; symbol?: string; priceUSD?: string;
  priceBlock?: string; metaBlock?: string; sourceLagBlocks?: string; priceLagBlocks?: string;
}
export function checkUsable(body: unknown, symbol: string, chainHead: bigint | string): UsabilityResult;
