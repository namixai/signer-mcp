/**
 * Venue normalization layer — canonical symbol + canonical size.
 *
 * WHY THIS EXISTS (CRITICAL bug, 2026-06-11): OKX perpetual swap order size is
 * denominated in CONTRACTS, not base asset. For BTC-USDT-SWAP, 1 contract =
 * 0.01 BTC (ctVal). The client used to pass `qty` through raw, so an agent
 * sending "0.01" (meaning 0.01 BTC) actually traded 0.01 contracts = 0.0001
 * BTC — a silent 100× undersize that turned a "balanced hedge" into a naked
 * position. Binance is base-asset-native, so the same number meant 100× more
 * there.
 *
 * Canonical contract of this module:
 *  - The user/agent ALWAYS speaks base asset (e.g. BTC) for `qty`, and may use
 *    a canonical symbol (`BTC`, `BTCUSDT`, `BTC/USDT`) or the venue-native one.
 *  - We translate to venue-native symbol + venue-native size at this edge, and
 *    ECHO the translation back so the agent always sees what actually went to
 *    the exchange.
 *  - Anything we cannot translate exactly is REJECTED with a clear error —
 *    never silently rounded, never passed through in the wrong unit.
 */

// ── Canonical symbol mapping ──

/**
 * Quote/suffix decorations we strip to recover the canonical base asset from
 * user input. Longest-first so "-USDT-SWAP" wins over "-USDT". USD-quoted
 * perps (asterdex "BTC-USD") map to the same base; we only support USDT/USD
 * linear perps today (matches the venues in STATIC_VENUES).
 */
const STRIP_SUFFIXES = [
  "-USDT-SWAP",
  "USDTM",
  "-USDT",
  "/USDT",
  "USDT",
  "-USD",
  "/USD",
] as const;

/** KuCoin Futures uses XBT for Bitcoin (XBTUSDTM). Canonical base is BTC. */
const BASE_ALIASES: Record<string, string> = { XBT: "BTC" };

/** venue → (canonical base → venue-native symbol) builder. */
const NATIVE_SYMBOL_BUILDERS: Record<string, (base: string) => string> = {
  binance: (b) => `${b}USDT`,
  okx: (b) => `${b}-USDT-SWAP`,
  bybit: (b) => `${b}USDT`,
  kucoin: (b) => `${b === "BTC" ? "XBT" : b}USDTM`,
  hyperliquid_main: (b) => b,
  asterdex: (b) => `${b}-USD`,
};

export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizationError";
  }
}

/**
 * Extract the canonical base asset from any accepted spelling: bare base
 * ("BTC"), canonical pair ("BTCUSDT", "BTC/USDT"), or any venue's native
 * symbol ("BTC-USDT-SWAP", "XBTUSDTM", "BTC-USD"). Throws on anything that
 * doesn't parse to a plausible base ticker.
 */
export function canonicalBase(symbolInput: string): string {
  const raw = symbolInput.trim().toUpperCase();
  if (raw.length === 0) throw new NormalizationError("symbol is empty");
  let base = raw;
  for (const suffix of STRIP_SUFFIXES) {
    if (base.endsWith(suffix) && base.length > suffix.length) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  base = BASE_ALIASES[base] ?? base;
  // A quote currency alone is never a valid base ("USDT" would build
  // "USDTUSDT" on binance) — reject instead of constructing nonsense.
  if (["USDT", "USD", "USDC", "BUSD"].includes(base)) {
    throw new NormalizationError(
      `"${symbolInput}" is a quote currency, not a tradable base asset — ` +
        `pass the base (e.g. "BTC") or a pair (e.g. "BTCUSDT").`,
    );
  }
  // A base ticker is 2-10 letters/digits, no separators left over.
  if (!/^[A-Z0-9]{2,10}$/.test(base)) {
    throw new NormalizationError(
      `cannot derive a base asset from symbol "${symbolInput}" — use the ` +
        `canonical base (e.g. "BTC"), a canonical pair (e.g. "BTCUSDT"), or ` +
        `the venue-native symbol (e.g. "BTC-USDT-SWAP" on okx).`,
    );
  }
  return base;
}

/**
 * Map any accepted symbol spelling to the venue-native symbol. Unknown venue
 * → error (never guess a format for a venue we haven't mapped).
 */
export function toNativeSymbol(venue: string, symbolInput: string): string {
  const build = NATIVE_SYMBOL_BUILDERS[venue];
  if (build === undefined) {
    throw new NormalizationError(
      `no symbol mapping for venue "${venue}" — pass the venue-native symbol ` +
        `exactly as the venue expects it (see list_venues notes).`,
    );
  }
  return build(canonicalBase(symbolInput));
}

// ── Canonical size (OKX contracts conversion) ──

/**
 * Pinned OKX SWAP instrument specs (source: GET /api/v5/public/instruments,
 * verified live 2026-06-11). ctVal = base asset per 1 contract; lotSz/minSz
 * are in CONTRACTS. Pinned instead of fetched so order sizing never depends
 * on a live OKX call (and can't be tampered with in transit); extend the
 * table when a new instrument is approved. Anything NOT in this table is
 * rejected — fail closed, no raw pass-through (that's the 100× bug).
 */
export interface OkxInstrumentSpec {
  ctVal: string; // base asset per contract
  lotSz: string; // contract size step
  minSz: string; // minimum contracts
}

export const OKX_SWAP_SPECS: Record<string, OkxInstrumentSpec> = {
  "BTC-USDT-SWAP": { ctVal: "0.01", lotSz: "0.01", minSz: "0.01" },
  "ETH-USDT-SWAP": { ctVal: "0.1", lotSz: "0.01", minSz: "0.01" },
  "SOL-USDT-SWAP": { ctVal: "1", lotSz: "0.01", minSz: "0.01" },
};

/**
 * Exact decimal → scaled integer. Throws if the value has more decimal places
 * than `scale` (we never round a user's size). Operates on the string form to
 * avoid float artifacts (0.1 + 0.2 class).
 */
function toScaledInt(value: string, scale: number): number {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new NormalizationError(`"${value}" is not a plain positive decimal`);
  }
  const [whole, frac = ""] = value.split(".");
  if (frac.length > scale) {
    const excess = frac.slice(scale);
    if (/[^0]/.test(excess)) {
      throw new NormalizationError(
        `"${value}" has more precision than supported (max ${scale} decimal places here)`,
      );
    }
  }
  const fracPadded = frac.slice(0, scale).padEnd(scale, "0");
  const scaled = Number(`${whole}${fracPadded}`);
  if (!Number.isSafeInteger(scaled)) {
    throw new NormalizationError(`"${value}" is too large to convert safely`);
  }
  return scaled;
}

export interface SizeTranslation {
  /** Venue-native size string to put on the wire (e.g. OKX `sz`). */
  nativeQty: string;
  /** Unit of nativeQty: "contracts" (okx) or "base" (binance et al). */
  nativeUnit: "contracts" | "base";
  /** Base asset per contract, when nativeUnit = contracts. */
  ctVal?: string;
}

/** Render a scaled integer back to a minimal decimal string. */
function fromScaledInt(scaled: number, scale: number): string {
  const s = String(scaled).padStart(scale + 1, "0");
  const whole = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale).replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

/**
 * Convert a base-asset quantity to the venue-native order size.
 *
 *  - binance (and other base-denominated venues): pass-through, unit "base".
 *  - okx: contracts = qtyBase / ctVal, REQUIRED to be ≥ minSz and an exact
 *    multiple of lotSz. Off-grid or unknown instruments are rejected with the
 *    exact valid choices spelled out — never silently rounded to a different
 *    size than the user asked for.
 */
export function toNativeQty(
  venue: string,
  nativeSymbol: string,
  qtyBase: number,
): SizeTranslation {
  if (!(Number.isFinite(qtyBase) && qtyBase > 0)) {
    throw new NormalizationError(`qty must be a positive number, got ${qtyBase}`);
  }
  const qtyStr = String(qtyBase);
  // Exponent forms ("1e-7", "1e+21") must never reach an exchange wire —
  // venues expect plain decimals and may mis-parse or opaquely reject them.
  // This applies to EVERY venue, not just contract-denominated ones.
  if (!/^\d+(\.\d+)?$/.test(qtyStr)) {
    throw new NormalizationError(
      `qty ${qtyStr} is not expressible as a plain decimal (too small/large) — ` +
        `use a size the venue can actually accept.`,
    );
  }
  if (venue !== "okx") {
    // Float artifacts ("0.30000000000000004") ARE plain decimals — gate them
    // with the same ≤8-decimal-places rule as the contracts path. No crypto
    // perp sizes base qty finer than 1e-8; a 16-digit fraction is an artifact.
    toScaledInt(qtyStr, 8);
    return { nativeQty: qtyStr, nativeUnit: "base" };
  }
  const spec = OKX_SWAP_SPECS[nativeSymbol];
  if (spec === undefined) {
    throw new NormalizationError(
      `okx order size for "${nativeSymbol}" cannot be converted: instrument ` +
        `not in the pinned spec table (${Object.keys(OKX_SWAP_SPECS).join(", ")}). ` +
        `OKX sizes are in CONTRACTS (ctVal varies per instrument) — refusing to ` +
        `pass a base-asset qty through raw. Ask Usenami to pin this instrument.`,
    );
  }
  // All arithmetic on integers scaled by 1e8 (covers ctVal/lotSz precision).
  const SCALE = 8;
  const qtyInt = toScaledInt(String(qtyBase), SCALE);
  const ctValInt = toScaledInt(spec.ctVal, SCALE);
  const lotInt = toScaledInt(spec.lotSz, SCALE);
  const minInt = toScaledInt(spec.minSz, SCALE);
  // contracts = qty / ctVal; grid step in base units = lotSz * ctVal.
  const stepBaseInt = (lotInt * ctValInt) / 10 ** SCALE; // exact for our specs
  if (!Number.isInteger(stepBaseInt) || stepBaseInt <= 0) {
    throw new NormalizationError(
      `internal: lot grid for ${nativeSymbol} did not scale to an integer — refusing to size`,
    );
  }
  if (qtyInt % stepBaseInt !== 0) {
    const below = Math.floor(qtyInt / stepBaseInt) * stepBaseInt;
    const above = below + stepBaseInt;
    // below can be 0 (qty under one lot step) — 0 is not a valid order size,
    // so only offer it when it's a real choice.
    const choices =
      below > 0
        ? `${fromScaledInt(below, SCALE)} or ${fromScaledInt(above, SCALE)}`
        : fromScaledInt(above, SCALE);
    throw new NormalizationError(
      `okx ${nativeSymbol}: ${qtyBase} base is not a clean ` +
        `multiple of the contract grid (1 contract = ${spec.ctVal} base, lot step ` +
        `${spec.lotSz} contracts = ${fromScaledInt(stepBaseInt, SCALE)} base). ` +
        `Nearest valid size(s): ${choices} base. ` +
        `Refusing to round silently.`,
    );
  }
  // Exact integer arithmetic only: qtyInt is a verified multiple of
  // stepBaseInt, so k (number of lot steps) is an exact integer, and
  // contractsInt = k * lotInt needs no float division or rounding at all.
  const k = qtyInt / stepBaseInt;
  const contractsInt = k * lotInt; // scaled contracts
  if (!Number.isSafeInteger(contractsInt)) {
    throw new NormalizationError(
      `okx ${nativeSymbol}: ${qtyBase} base converts to a contract count too ` +
        `large to represent safely — refusing to size.`,
    );
  }
  if (contractsInt < minInt) {
    throw new NormalizationError(
      `okx ${nativeSymbol}: ${qtyBase} base = ${fromScaledInt(contractsInt, SCALE)} contracts, ` +
        `below the venue minimum ${spec.minSz} contracts (= ${fromScaledInt((minInt * ctValInt) / 10 ** SCALE, SCALE)} base).`,
    );
  }
  return {
    nativeQty: fromScaledInt(contractsInt, SCALE),
    nativeUnit: "contracts",
    ctVal: spec.ctVal,
  };
}

// ── Echo payload ──

export interface OrderTranslation {
  requested: { symbol: string; qty: number; unit: "base_asset" };
  sent: { symbol: string; qty: string; unit: "contracts" | "base"; ctVal?: string };
  note?: string;
}

/** Build the full symbol+size translation for an order, with the echo body. */
export function translateOrder(
  venue: string,
  symbolInput: string,
  qtyBase: number,
): { nativeSymbol: string; nativeQty: string; echo: OrderTranslation } {
  const nativeSymbol = toNativeSymbol(venue, symbolInput);
  const size = toNativeQty(venue, nativeSymbol, qtyBase);
  const echo: OrderTranslation = {
    requested: { symbol: symbolInput, qty: qtyBase, unit: "base_asset" },
    sent: {
      symbol: nativeSymbol,
      qty: size.nativeQty,
      unit: size.nativeUnit,
      ...(size.ctVal !== undefined ? { ctVal: size.ctVal } : {}),
    },
  };
  if (size.nativeUnit === "contracts") {
    echo.note =
      `okx sizes orders in CONTRACTS: ${qtyBase} base asset = ${size.nativeQty} ` +
      `contracts (1 contract = ${size.ctVal} base). Verify the filled size on the ` +
      `exchange matches the requested base amount.`;
  }
  return { nativeSymbol, nativeQty: size.nativeQty, echo };
}
