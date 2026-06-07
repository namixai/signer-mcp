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
 *   3. Send `tools/list` → expect 5 tools.
 *   4. Call `list_venues` → expect 6 venues
 *      (binance/okx/asterdex/kucoin/bybit/hyperliquid_main).
 *   5. Call `get_attestation` → expect either success (gateway up) or a
 *      gateway-unreachable error with the right hint message.
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
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, "..", "dist", "index.js");
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
    check(
      "tools/list returns 5 tools",
      toolNames.length === 5,
      `got: ${toolNames.join(", ")}`,
    );
    check(
      "expected tool set",
      JSON.stringify(toolNames) ===
        JSON.stringify(
          ["cancel_order", "get_account", "get_attestation", "list_venues", "place_order"].sort(),
        ),
      `got: ${toolNames.join(", ")}`,
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
    check(
      "list_venues returns 6 venues",
      venuesBody.count === 6,
      `got ${venuesBody.count}`,
    );
    const venueIds = venuesBody.venues.map((v) => v.venue).sort();
    check(
      "venues are binance/okx/asterdex/kucoin/bybit/hyperliquid_main",
      JSON.stringify(venueIds) ===
        JSON.stringify(
          ["asterdex", "binance", "bybit", "hyperliquid_main", "kucoin", "okx"],
        ),
      `got: ${venueIds.join(",")}`,
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
