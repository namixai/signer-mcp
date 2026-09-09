export interface SnapshotResult {
  ok: boolean; snapshot?: Record<string, unknown>; bytes?: number;
  refusal?: { reason: string; detail: unknown; [k: string]: unknown };
}
export function buildSnapshot(input: Record<string, unknown>): SnapshotResult;
export function bandFor(price: string, bps?: number): Record<string, unknown>;
export function judgeOrder(snapshot: unknown, price: string): { allowed: boolean; [k: string]: unknown };
