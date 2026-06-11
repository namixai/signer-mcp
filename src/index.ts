#!/usr/bin/env node
/**
 * @usenami/signer-mcp — v0 (MCP entry point)
 *
 * Sign CEX orders from any MCP-aware AI agent (Claude Desktop, Cursor, ElizaOS)
 * with keys that never leave an AWS Nitro Enclave.
 *
 * v0 ships five tools backed by the Usenami Signer gateway. Tool logic lives in
 * `lib.ts` so unit tests can exercise it without booting the MCP transport.
 *
 * Configuration (claude_desktop_config.json):
 *
 *   {
 *     "mcpServers": {
 *       "signer": {
 *         "command": "npx",
 *         "args": ["-y", "@usenami/signer-mcp"],
 *         "env": {
 *           "SIGNER_GATEWAY_URL": "https://signer.usenami.io",
 *           "SIGNER_API_TOKEN": "...issued from signer.usenami.io..."
 *         }
 *       }
 *     }
 *   }
 *
 * Scope-guard §6 of the design doc: stdio only, no multi-tenant, no UPL UI,
 * no streaming, no cross-venue routing, no withdrawals — the enclave key
 * NEVER leaves the enclave; this process only proxies intents.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  GatewayConfig,
  PACKAGE_VERSION,
  STATIC_VENUES,
  handleCancelOrder,
  handleGetAccount,
  handleGetAttestation,
  handleListVenues,
  handlePlaceHedge,
  handlePlaceOrder,
} from "./lib.js";
import { getAccountParser } from "./parsers/index.js";

// ── Environment ──
const GATEWAY_URL = (
  process.env.SIGNER_GATEWAY_URL || "https://signer.usenami.io"
).replace(/\/+$/, "");
const API_TOKEN = (process.env.SIGNER_API_TOKEN || "").trim();
// Optional override for fetch timeout — useful when running the smoke test
// against an unreachable host or in CI where 30s is too slow. Validated to
// be a positive integer; falls back to lib's DEFAULT_FETCH_TIMEOUT_MS otherwise.
const TIMEOUT_RAW = (process.env.SIGNER_FETCH_TIMEOUT_MS || "").trim();
const TIMEOUT_MS = (() => {
  if (TIMEOUT_RAW.length === 0) return undefined;
  const n = parseInt(TIMEOUT_RAW, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
})();
const cfg: GatewayConfig = {
  gatewayUrl: GATEWAY_URL,
  apiToken: API_TOKEN || undefined,
  fetchTimeoutMs: TIMEOUT_MS,
};
const HAS_TOKEN = API_TOKEN.length > 0;

// ── MCP tool annotations ──
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true as const,
  destructiveHint: false as const,
  idempotentHint: true as const,
  openWorldHint: true as const,
};

const WRITE_DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false as const,
  destructiveHint: true as const,
  idempotentHint: false as const,
  openWorldHint: true as const,
};

// ── Tool descriptions (read by agents) ──
const DESC_LIST_VENUES =
  "List the venues this Signer can sign trades for. Returns the venue id, " +
  "asset class (perp / spot / margin), and auth scheme (hmac / eip712 / " +
  "ed25519). Read-only static manifest — does NOT need the Signer gateway " +
  "to be reachable. Call this first to discover what's signable.";

const DESC_GET_ATTESTATION =
  "Return the Signer enclave's AWS Nitro attestation document (PCR0, " +
  "PCR1, PCR2 measurements + AWS-issued signature). This proves the code " +
  "currently signing your orders matches the published source. The enclave's " +
  "signing key NEVER leaves attested code. Verify the PCR0 against " +
  "https://usenami.io/signer/attestations before trusting any place_order.";

const DESC_GET_ACCOUNT =
  "Return equity, free margin, and open positions for a venue. Read-only " +
  "(does not sign anything that mutates state). Use BEFORE place_order to " +
  "confirm the account has margin. Requires SIGNER_API_TOKEN.";

const DESC_PLACE_ORDER =
  "Place a single order on the named venue. Accepts canonical symbol (BTC / " +
  "BTCUSDT) and qty in BASE ASSET; translates both to the venue's native " +
  "format (okx sizes in contracts) and echoes the translation in the result " +
  "— always check `translation.sent` to see what actually hit the exchange. " +
  "The Signer enclave signs the venue-native payload using a key that has " +
  "never been exported. Policy enforced server-side: orders that exceed " +
  "per-asset caps are rejected by the enclave before signing. Returns the " +
  "venue's order_id on success. Side effect: real or testnet trade " +
  "depending on venue env.";

const DESC_PLACE_HEDGE =
  "Place a 2-leg MARKET hedge ATOMICALLY: both legs are signed inside the " +
  "enclave (if either leg fails policy, NOTHING executes), then the gateway " +
  "fires both venue calls in parallel server-side — minimal leg gap, works " +
  "even when a venue geo-blocks your residential IP. Accepts canonical " +
  "symbol (BTC) + qty in BASE ASSET per leg (contract venues converted, " +
  "translation echoed per leg). Result status: executed (both venue " +
  "receipts accepted) | partial (ONE leg live — naked position, repair via " +
  "legs[].outcome) | unknown (a receipt was lost — that leg MAY be live: " +
  "reconcile with get_account BEFORE any retry, never blind-retry) | " +
  "failed (both rejected, safe to retry). Market orders only in v1. Side " +
  "effect: real or testnet trades.";

const DESC_CANCEL_ORDER =
  "Cancel an outstanding order by its venue order_id. Signed inside the " +
  "enclave just like place_order. Returns the cancellation receipt from " +
  "the venue. Idempotent: cancelling a non-existent / already-filled " +
  "order returns ok=false with a reason from the venue.";

// ── Schemas ──
const VenueIdSchema = z
  .enum(STATIC_VENUES.map((v) => v.venue) as [string, ...string[]])
  .describe(
    "Venue identifier. Must match an entry returned by list_venues — " +
      "any other value will be rejected by the gateway.",
  );

const TickerSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9/_-]+$/, "Letters, digits, '-', '_' or '/' only")
  .describe(
    "Trading symbol — canonical or venue-native, we translate. Canonical: " +
      "base asset ('BTC') or pair ('BTCUSDT', 'BTC/USDT'). Venue-native also " +
      "accepted (BTC-USDT-SWAP on okx, XBTUSDTM on kucoin). The tool result " +
      "echoes the exact venue-native symbol that was sent.",
  );

const OrderSideSchema = z
  .enum(["buy", "sell"])
  .describe("buy = long open / short close; sell = short open / long close.");

const OrderTypeSchema = z
  .enum(["market", "limit"])
  .describe(
    "market = immediate fill at venue best; limit = resting order at `price`.",
  );

const QuantitySchema = z
  .number()
  .positive()
  .describe(
    "Order quantity ALWAYS in base asset (e.g. BTC) — NOT USD-notional and " +
      "NOT venue contracts. Venues that size orders in contracts (okx: 1 " +
      "contract = 0.01 BTC on BTC-USDT-SWAP) are converted automatically and " +
      "the conversion is echoed in the result. Sizes that don't fit the " +
      "venue's contract grid are rejected, never silently rounded.",
  );

const PriceSchema = z
  .number()
  .positive()
  .optional()
  .describe(
    "Limit price in quote asset. Required for type=limit, ignored for " +
      "type=market.",
  );

const PolicyIdSchema = z
  .string()
  .optional()
  .describe(
    "Optional policy id override. If omitted, the gateway uses the default " +
      "policy bound to the provided SIGNER_API_TOKEN.",
  );

// ── Server setup ──
const server = new McpServer({
  name: "@usenami/signer-mcp",
  version: PACKAGE_VERSION,
});

server.registerTool(
  "list_venues",
  {
    description: DESC_LIST_VENUES,
    inputSchema: {},
    annotations: { ...READ_ONLY_ANNOTATIONS, title: "List supported venues" },
  },
  async () => handleListVenues(),
);

server.registerTool(
  "get_attestation",
  {
    description: DESC_GET_ATTESTATION,
    inputSchema: {},
    annotations: {
      ...READ_ONLY_ANNOTATIONS,
      title: "Get Nitro attestation document",
    },
  },
  async () => handleGetAttestation(cfg),
);

server.registerTool(
  "get_account",
  {
    description: DESC_GET_ACCOUNT,
    inputSchema: { venue: VenueIdSchema },
    annotations: {
      ...READ_ONLY_ANNOTATIONS,
      title: "Get venue account snapshot",
    },
  },
  async (args) => handleGetAccount(cfg, args as { venue: string }, getAccountParser),
);

server.registerTool(
  "place_order",
  {
    description: DESC_PLACE_ORDER,
    inputSchema: {
      venue: VenueIdSchema,
      symbol: TickerSchema,
      side: OrderSideSchema,
      qty: QuantitySchema,
      type: OrderTypeSchema,
      price: PriceSchema,
      policy_id: PolicyIdSchema,
    },
    annotations: {
      ...WRITE_DESTRUCTIVE_ANNOTATIONS,
      title: "Place a single order via Signer enclave",
    },
  },
  async (args) =>
    handlePlaceOrder(cfg, args as Parameters<typeof handlePlaceOrder>[1]),
);

const HedgeLegSchema = z.object({
  venue: VenueIdSchema,
  symbol: TickerSchema,
  side: OrderSideSchema,
  qty: QuantitySchema,
  type: z
    .literal("market")
    .describe(
      "market only in v1 — a resting limit leg would make 'executed' hide " +
        "an unfilled leg. Use place_order for limit orders.",
    ),
});

server.registerTool(
  "place_hedge",
  {
    description: DESC_PLACE_HEDGE,
    inputSchema: {
      legs: z
        .array(HedgeLegSchema)
        .length(2)
        .describe(
          "Exactly 2 legs. Typical hedge: same symbol, opposite sides, " +
            "equal base-asset qty on two venues (e.g. buy 0.01 BTC binance + " +
            "sell 0.01 BTC okx).",
        ),
    },
    annotations: {
      ...WRITE_DESTRUCTIVE_ANNOTATIONS,
      title: "Place an atomic 2-leg hedge",
    },
  },
  async (args) =>
    handlePlaceHedge(cfg, args as Parameters<typeof handlePlaceHedge>[1]),
);

server.registerTool(
  "cancel_order",
  {
    description: DESC_CANCEL_ORDER,
    inputSchema: {
      venue: VenueIdSchema,
      order_id: z
        .string()
        .min(1)
        .describe("Venue-native order identifier returned by place_order."),
      symbol: TickerSchema.optional().describe(
        "Venue-native symbol — REQUIRED for binance + okx cancels (their " +
          "REST APIs need the symbol on the cancel route). Optional for " +
          "venues that derive it from order_id alone.",
      ),
    },
    annotations: {
      readOnlyHint: false as const,
      destructiveHint: false as const,
      idempotentHint: true as const,
      openWorldHint: true as const,
      title: "Cancel an outstanding order",
    },
  },
  async (args) =>
    handleCancelOrder(cfg, args as { venue: string; order_id: string; symbol?: string }),
);

// ── Boot ──
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[signer-mcp v${PACKAGE_VERSION}] connected — gateway=${GATEWAY_URL} ` +
      `auth=${HAS_TOKEN ? "yes" : "no"}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[signer-mcp] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
