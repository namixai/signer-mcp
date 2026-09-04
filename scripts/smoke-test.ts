#!/usr/bin/env node
/**
 * signer-mcp smoke test — verifies the v0 server boots, registers tools,
 * and the read-only path (list_venues + get_attestation) works end-to-end.
 *
 * Usage:
 *   SIGNER_GATEWAY_URL=https://signer.usenami.io \
 *   SIGNER_API_TOKEN=sk_test_... \
 *   npx tsx scripts/smoke-test.ts
 *
 * What it does (in order):
 *   1. Spawn `node dist/index.js` with the env above.
 *   2. Send `initialize` → expect protocol-version handshake.
 *   3. Send `tools/list` → expect exactly the tools REGISTERED IN src/index.ts.
 *   4. Call `list_venues` → expect exactly STATIC_VENUES from the built lib.
 *   5. Call `get_attestation` → expect either success (gateway up) or a
 *      gateway-unreachable error with the right hint message.
 *
 * 🔴 Expectations are READ FROM THE SOURCE, not listed here. The previous
 * version listed "5 tools" and "6 venues" by hand; place_hedge (0.5.0) and
 * hyperliquid_testnet arrived, nothing ran this script (no CI in this repo;
 * the terminal release workflow builds a 0.2.0 copy), and it sat red and
 * unnoticed until 2026-09-04 while the server itself booted fine. A listed
 * table is a table someone forgets to update; a check nobody runs cannot go
 * red. This script is now the CI gate (.github/workflows/ci.yml).
 *
 * Exits 0 on full pass, 1 on any check fail. Use as a CI gate or a
 * 30-second post-deploy verify before recording the demo.
 *
 * What it does NOT exercise: get_account / place_order / cancel_order.
 * Those require live gateway endpoints + a funded testnet account, so
 * they're driven separately via mcp-inspector once Binance testnet path
 * is live.
 */

import { spawn, ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, "..", "dist", "index.js");
const SOURCE_PATH = path.resolve(__dirname, "..", "src", "index.ts");
const LIB_PATH = path.resolve(__dirname, "..", "dist", "lib.js");

/**
 * Tool names as registered in src/index.ts — read from the source text, the
 * way signer#79 reads route paths: a registration added tomorrow is covered
 * without anyone editing this file. The floor guards the extractor itself:
 * reading nothing must fail, not pass on an empty set.
 */
function registeredToolNames(): string[] {
  // Comments stripped first: a registration mentioned in prose (or commented
  // out) is not a registration — the marker-matches-prose trap of signer#79.
  const src = readFileSync(SOURCE_PATH, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const names = [...src.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  if (names.length < 5) {
    throw new Error(
      `read ${names.length} registerTool() calls from ${SOURCE_PATH} — ` +
        "the extractor is reading nothing and would pass on anything",
    );
  }
  return names.sort();
}

/** Venue ids the server ships, from the built lib — the same table the tool serves. */
async function shippedVenueIds(): Promise<string[]> {
  const lib = (await import(pathToFileURL(LIB_PATH).href)) as {
    STATIC_VENUES: Array<{ venue: string }>;
  };
  const ids = lib.STATIC_VENUES.map((v) => v.venue).sort();
  if (ids.length < 5) {
    throw new Error(`STATIC_VENUES has ${ids.length} entries — not the venue table`);
  }
  return ids;
}
const STARTUP_GRACE_MS = 500;
// 8s: long enough for a real attestation round-trip on slow networks,
// short enough that an unreachable host fails fast in CI. The MCP server
// itself uses SIGNER_FETCH_TIMEOUT_MS (default 3000 here) to cap its
// underlying fetch so the toolError surfaces well before this step timeout.
const STEP_TIMEOUT_MS = 8_000;
const SMOKE_FETCH_TIMEOUT_MS = "3000";

interface JsonRpc {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpClient {
  private buf = "";
  private waiters: Map<number, (msg: JsonRpc) => void> = new Map();
  private nextId = 1;
  constructor(private proc: ChildProcess) {
    proc.stdout!.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString();
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line.length === 0) continue;
        try {
          const msg: JsonRpc = JSON.parse(line);
          if (typeof msg.id === "number" && this.waiters.has(msg.id)) {
            const resolve = this.waiters.get(msg.id)!;
            this.waiters.delete(msg.id);
            resolve(msg);
          }
        } catch {
          // Server may emit diagnostic lines on stdout in rare cases; ignore.
        }
      }
    });
    proc.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(`[server] ${chunk.toString()}`);
    });
  }
  async send(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const req: JsonRpc = { jsonrpc: "2.0", id, method, params };
    this.proc.stdin!.write(JSON.stringify(req) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`${method} timed out after ${STEP_TIMEOUT_MS}ms`));
      }, STEP_TIMEOUT_MS);
      this.waiters.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) {
          reject(new Error(`${method} returned error: ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
      });
    });
  }
  notify(method: string, params?: unknown): void {
    this.proc.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }
}

let failed = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    failed++;
    console.error(`✗ ${label}${detail ? `\n  ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const proc = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Cap fetch timeout below the step timeout so toolError fires before
      // the JSON-RPC step wrapper times out. Pre-existing env wins.
      SIGNER_FETCH_TIMEOUT_MS:
        process.env.SIGNER_FETCH_TIMEOUT_MS || SMOKE_FETCH_TIMEOUT_MS,
    },
  });
  proc.on("error", (err) => {
    console.error(`failed to spawn: ${err.message}`);
    process.exit(1);
  });
  // Give the server a moment to print its readiness banner to stderr.
  await new Promise((r) => setTimeout(r, STARTUP_GRACE_MS));

  const client = new McpClient(proc);

  try {
    // 1) initialize
    const init = (await client.send("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "signer-mcp-smoke-test", version: "0" },
      capabilities: {},
    })) as { protocolVersion?: string; serverInfo?: { name?: string } };
    check(
      "initialize handshake returns protocolVersion",
      typeof init.protocolVersion === "string",
      `got ${JSON.stringify(init)}`,
    );
    check(
      "server identifies as @usenami/signer-mcp",
      init.serverInfo?.name === "@usenami/signer-mcp",
      `got ${init.serverInfo?.name}`,
    );

    client.notify("notifications/initialized");

    // 2) tools/list
    const tools = (await client.send("tools/list")) as {
      tools: Array<{ name: string }>;
    };
    const toolNames = tools.tools.map((t) => t.name).sort();
    const registered = registeredToolNames();
    check(
      `tools/list returns exactly the ${registered.length} tools registered in src/index.ts`,
      JSON.stringify(toolNames) === JSON.stringify(registered),
      `got: ${toolNames.join(", ")}\n  registered: ${registered.join(", ")}`,
    );

    // 3) list_venues
    const venues = (await client.send("tools/call", {
      name: "list_venues",
      arguments: {},
    })) as { content: Array<{ text: string }>; isError?: boolean };
    check("list_venues did not error", !venues.isError);
    const venuesBody = JSON.parse(venues.content[0].text) as {
      count: number;
      venues: Array<{ venue: string }>;
    };
    const shipped = await shippedVenueIds();
    check(
      `list_venues count matches STATIC_VENUES (${shipped.length})`,
      venuesBody.count === shipped.length,
      `got ${venuesBody.count}`,
    );
    const venueIds = venuesBody.venues.map((v) => v.venue).sort();
    check(
      "list_venues serves exactly the shipped venue table",
      JSON.stringify(venueIds) === JSON.stringify(shipped),
      `got: ${venueIds.join(",")}\n  shipped: ${shipped.join(",")}`,
    );

    // 4) get_attestation
    const attest = (await client.send("tools/call", {
      name: "get_attestation",
      arguments: {},
    })) as { content: Array<{ text: string }>; isError?: boolean };
    const attestBody = JSON.parse(attest.content[0].text);
    if (attest.isError) {
      check(
        "get_attestation error path: gateway-unreachable hint present",
        typeof attestBody.hint === "string" &&
          attestBody.hint.includes("list_venues still works"),
        `got: ${JSON.stringify(attestBody).slice(0, 200)}`,
      );
      console.log(
        "  (gateway not reachable — error path is correct; live verify requires gateway up)",
      );
    } else {
      check(
        "get_attestation returns PCR0 field",
        typeof attestBody.pcr0_sha384 === "string" &&
          attestBody.pcr0_sha384.length > 0,
        `got: ${JSON.stringify(attestBody).slice(0, 200)}`,
      );
    }
  } catch (err) {
    failed++;
    console.error(`fatal: ${(err as Error).message}`);
  } finally {
    proc.kill();
  }

  console.log(failed === 0 ? "\n✓ smoke test PASSED" : `\n✗ ${failed} checks failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
