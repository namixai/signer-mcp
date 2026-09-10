// Контракт перенесённых модулей, объявленный руками.
//
// Выводить типы из самого JS нельзя: tsc не умеет назвать инферированные типы клиентов
// viem при генерации деклараций и падает с TS2742. Явное объявление и точнее, и держит
// перенесённые файлы вне программы типов — они остаются побайтовой копией истины.
export interface PaidQueryResult {
  ok: boolean;
  reason?: string;
  detail?: unknown;
  status?: number;
  rawBody?: string;
  attestationHeader?: string | null;
  /** Отсутствие заголовка сообщается, а не подразумевается: образцов у нас два. */
  hasAttestation?: boolean;
  /** Адрес, с которого ушли деньги. */
  payer?: string;
  /** Бросок после отправки: списание могло пройти, «не потрачено» утверждать нельзя. */
  spendUnknown?: boolean;
  // 🔴 `subgraphId` здесь БЫЛО и никогда не возвращалось. Это объявление — единственная
  // проверка типов для перенесённых модулей, и именно оно позволило написать
  // `q.subgraphId` в graph-price.ts: снимок отказывался собираться, а нашлось платным
  // прогоном. Ложное поле в типе дороже отсутствующего.
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
export interface SymbolMatches {
  ok: boolean; reason?: string; detail?: unknown;
  tokens?: Array<Record<string, unknown>>; saturated?: boolean; limit?: number;
}
export function shapeSymbolMatches(rawBody: string | object, limit?: number): SymbolMatches;
