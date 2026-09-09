export interface VerificationResult {
  ok: boolean; reason?: string; detail?: unknown;
  allocationId?: string; subgraphDeploymentID?: string;
  requestCID?: string; responseCID?: string;
}
export function parseAttestationHeader(header: string | null | undefined): unknown;
export function verifyAttestation(rawBody: string | Uint8Array, attestation: unknown, network?: unknown): Promise<VerificationResult>;
