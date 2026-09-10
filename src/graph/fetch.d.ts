// Контракт перенесённых модулей, объявленный руками.
//
// Выводить типы из самого JS нельзя: tsc не умеет назвать инферированные типы клиентов
// viem при генерации деклараций и падает с TS2742. Явное объявление и точнее, и держит
// перенесённые файлы вне программы типов — они остаются побайтовой копией истины.
export interface PaidQueryResult {
  ok: boolean; reason?: string; detail?: unknown; status?: number;
  rawBody?: string; attestationHeader?: string | null; subgraphId?: string;
}
export function paidQuery(opts?: {
  subgraphId?: string; query?: string; gateway?: string;
  privateKey?: string; fetchImpl?: typeof fetch;
}): Promise<PaidQueryResult>;
export function quote(opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
export function decodeChallenge(value: unknown): Record<string, unknown>;
export function priceQueryByAddress(address: string): string;
export function priceQueryBySymbol(symbol: string, limit?: number): string;
export const SYMBOL_MATCH_LIMIT: number;
export const RECENT_PRICED_QUERY: string;
export const PRICE_QUERY: string;
export const UNISWAP_V3_ETHEREUM: string;
