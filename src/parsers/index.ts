/**
 * Venue parser dispatcher.
 *
 * Under the Option-A architecture (per signer 2026-05-31T2150 schema doc),
 * signer-mcp:
 *   1. calls signer gateway /account/<venue> → gets a signed read request
 *   2. fetches the venue URL with the signed headers
 *   3. dispatches the raw response to the venue-specific parser here
 *   4. returns a NormalizedAccount to the agent
 *
 * Adding a venue = adding a parser file + entry below. Pure TS, no enclave
 * involvement.
 */

import { parseAsterdexAccount } from "./asterdex.js";
import { parseBinanceAccount } from "./binance.js";
import { parseOkxAccount } from "./okx.js";
import type { AccountParser } from "./types.js";

const PARSERS: Record<string, AccountParser> = {
  binance: parseBinanceAccount,
  okx: parseOkxAccount,
  asterdex: parseAsterdexAccount,
};

export function getAccountParser(venue: string): AccountParser | undefined {
  return PARSERS[venue];
}

export type { NormalizedAccount, NormalizedPosition, SignedRequest } from "./types.js";
