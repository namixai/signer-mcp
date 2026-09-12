/**
 * Falsification tests for attestation verification.
 *
 * Two rules this file obeys, both learned expensively elsewhere in this codebase:
 *
 *   * The fixture is a PRODUCTION EXTRACT — a real document from the live gateway,
 *     captured 12 September 2026 with the nonce stored beside it. A document we
 *     assembled ourselves would agree with our own assumptions and prove nothing.
 *   * Every mutation is asserted to have applied before its result is judged. A
 *     falsification that silently failed to apply prints green and tests nothing.
 *
 * The case that matters most is `a forged chain`: a complete, internally valid forgery
 * that claims the real measurement. Before the pinned root it would have passed every
 * check, and `get_attestation` is the surface a third-party agent consumes.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NITRO_ROOT_SHA256,
  decodeCbor,
  sigStructure,
  verifyAttestationBody,
} from "../src/attestation.js";
import { handleGetAttestation } from "../src/lib.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = () =>
  JSON.parse(readFileSync(join(here, "fixtures/attestation/live.json"), "utf8")) as Record<
    string,
    unknown
  >;
const fixtureNonce = (
  JSON.parse(
    readFileSync(join(here, "fixtures/attestation/live.nonce.json"), "utf8"),
  ) as { nonce: string }
).nonce;

/** A guard that cannot be optimised away and says which mutation failed to apply. */
/** CBOR head byte(s) for a major type and length — enough for rebuilding test documents. */
function headOf(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
}

function mutationApplied(condition: boolean, what: string): void {
  if (!condition) throw new Error(`MUTATION DID NOT APPLY: ${what}`);
}

// ── CBOR encoding, only for building documents in tests ──
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  if (n < 0x1_0000_0000) {
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = (major << 5) | 27;
  b.writeBigUInt64BE(BigInt(n), 1);
  return b;
}

type Encodable =
  | number
  | string
  | Buffer
  | null
  | Encodable[]
  | Map<Encodable, Encodable>;

function encode(o: Encodable): Buffer {
  if (o === null) return Buffer.from([0xf6]);
  if (typeof o === "number") {
    return o >= 0 ? head(0, o) : head(1, -1 - o);
  }
  if (Buffer.isBuffer(o)) return Buffer.concat([head(2, o.length), o]);
  if (typeof o === "string") {
    const b = Buffer.from(o, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Array.isArray(o)) {
    return Buffer.concat([head(4, o.length), ...o.map(encode)]);
  }
  const parts: Buffer[] = [head(5, o.size)];
  for (const [k, v] of o) parts.push(encode(k), encode(v));
  return Buffer.concat(parts);
}

/** Rebuild a COSE_Sign1 from parts, so a mutated payload can be re-wrapped. */
function cose(protectedBytes: Buffer, payloadBytes: Buffer, signature: Buffer): string {
  const bstr = (x: Buffer) => Buffer.concat([head(2, x.length), x]);
  return Buffer.concat([
    head(4, 4),
    bstr(protectedBytes),
    Buffer.from([0xa0]),
    bstr(payloadBytes),
    bstr(signature),
  ]).toString("base64");
}

function parts(body: Record<string, unknown>) {
  const raw = Buffer.from(body.attestation_doc_b64 as string, "base64");
  const sign1 = decodeCbor(raw) as Buffer[];
  const payload = decodeCbor(sign1[2]!) as Map<unknown, unknown>;
  return { sign1, payload };
}

describe("verifyAttestationBody — the honest document", () => {
  it("verifies, and reports PCR0 from the signed bytes", () => {
    const v = verifyAttestationBody(fixture(), fixtureNonce);
    // 🔴 chain_verified is NOT asserted here: Nitro leaf certificates are short-lived,
    // so a stored document's chain expires on its own schedule and an assertion on it
    // would go red on a calendar rather than on a defect. It is exercised live by
    // handleGetAttestation and by the forged-chain case below, whose chain is minted now.
    expect(v.checks.document_readable).toBe(true);
    expect(v.checks.nonce_echoed).toBe(true);
    expect(v.checks.root_pinned).toBe(true);
    expect(v.checks.signature_verified).toBe(true);
    expect(v.unreadable).toBeUndefined();
    expect(v.pcr0).toMatch(/^[0-9a-f]{96}$/);
    expect(v.rootSha256).toBe(NITRO_ROOT_SHA256);

    // And the measurement really comes out of the document, not from anywhere else.
    const { payload } = parts(fixture());
    const pcrs = payload.get("pcrs") as Map<number, Buffer>;
    expect(v.pcr0).toBe(pcrs.get(0)!.toString("hex"));
  });

  it("🔴 does not treat a `pcr0` FIELD as a measurement", () => {
    // This is the old defect as a test. The previous handler forwarded whatever the
    // gateway sent, so a body carrying only `pcr0: "abc123"` was reported to the agent
    // as the enclave's measurement. Nothing signed it; nothing had to.
    const v = verifyAttestationBody({ pcr0: "abc123" }, fixtureNonce);
    expect(v.verified).toBe(false);
    expect(v.pcr0).toBeUndefined();
    expect(v.unreadable).toContain("attestation_doc_b64");
  });
});

describe("CBOR — a legal re-packing is not a defect", () => {
  it("🔴 accepts a COSE_Sign1 wrapped in tag 18, and verifies it identically", () => {
    // RFC 8152 permits the tag. Our gateway sends the document untagged, so this branch
    // was never exercised and, before it existed, a tagged document was refused with
    // "unsupported major type 6" — calling a valid attestation unreadable and blaming the
    // producer. Nothing broke because nothing sent one; that is not the same as correct.
    const body = fixture();
    const raw = Buffer.from(body.attestation_doc_b64 as string, "base64");
    mutationApplied(raw[0] === 0x84, "the fixture is not a bare 4-item array to begin with");
    const tagged = Buffer.concat([Buffer.from([0xd2]), raw]);
    mutationApplied(tagged[0] === 0xd2, "the tag byte did not get prepended");

    const plain = verifyAttestationBody(body, fixtureNonce);
    const wrapped = verifyAttestationBody(
      { ...body, attestation_doc_b64: tagged.toString("base64") },
      fixtureNonce,
    );
    expect(wrapped.unreadable).toBeUndefined();
    expect(wrapped.checks.document_readable).toBe(true);
    // Identical verdict, not merely "also readable": same measurement, same signature
    // result. A tag carries no bytes into the Sig_structure.
    expect(wrapped.pcr0).toBe(plain.pcr0);
    expect(wrapped.checks.signature_verified).toBe(plain.checks.signature_verified);
    expect(wrapped.checks.root_pinned).toBe(plain.checks.root_pinned);
  });

  it("🔴 refuses tag 18 INSIDE the document — header and payload both", () => {
    // The first version of the tag branch unwrapped tag 18 anywhere, and the same decoder
    // reads sign1[0] and sign1[2]. A tagged protected header or payload would have
    // unwrapped and then passed the type checks: a document no COSE implementation
    // produces, accepted over bytes whose framing we had rewritten.
    const body = fixture();
    const raw = Buffer.from(body.attestation_doc_b64 as string, "base64");
    const sign1 = decodeCbor(raw, true) as Buffer[];
    const bstr = (x: Buffer) => Buffer.concat([headOf(2, x.length), x]);

    for (const [label, prot, payload] of [
      ["tagged protected header", Buffer.concat([Buffer.from([0xd2]), sign1[0]!]), sign1[2]!],
      ["tagged payload", sign1[0]!, Buffer.concat([Buffer.from([0xd2]), sign1[2]!])],
    ] as Array<[string, Buffer, Buffer]>) {
      const rebuilt = Buffer.concat([
        headOf(4, 4),
        bstr(prot),
        Buffer.from([0xa0]),
        bstr(payload),
        bstr(sign1[3]!),
      ]);
      mutationApplied(!rebuilt.equals(raw), `${label}: rebuild produced the original bytes`);
      const v = verifyAttestationBody(
        { ...body, attestation_doc_b64: rebuilt.toString("base64") },
        fixtureNonce,
      );
      // Must be unreadable — not "parsed and then failed a check", which is what the
      // recursive version produced and which misdirects the reader to the signature.
      expect(v.verified, label).toBe(false);
      expect(typeof v.unreadable, label).toBe("string");
      expect(v.pcr0, label).toBeUndefined();
      expect(v.checks.document_readable, label).toBe(false);
    }
  });

  it("refuses any OTHER tag by number rather than swallowing it", () => {
    const body = fixture();
    const raw = Buffer.from(body.attestation_doc_b64 as string, "base64");
    // Tag 61 (CWT) is legal CBOR and wrong here. Accepting semantics we do not implement
    // is how a parser starts agreeing to things.
    const wrong = Buffer.concat([Buffer.from([0xd8, 0x3d]), raw]);
    const v = verifyAttestationBody(
      { ...body, attestation_doc_b64: wrong.toString("base64") },
      fixtureNonce,
    );
    expect(v.verified).toBe(false);
    expect(v.pcr0).toBeUndefined();
    expect(typeof v.unreadable).toBe("string");
  });
});

describe("verifyAttestationBody — each check can go red", () => {
  it("a nonce we never sent reddens nonce_echoed and says why", () => {
    const other = "00".repeat(16);
    mutationApplied(other !== fixtureNonce, "the fixture's nonce IS all zeros");
    const v = verifyAttestationBody(fixture(), other);
    expect(v.checks.nonce_echoed).toBe(false);
    expect(v.verified).toBe(false);
    expect(v.notes.join(" ")).toContain("not the one we sent");
  });

  it("a document with NO nonce is called out as unbound, not merely different", () => {
    // The gateway returns `nonce: null` when none was requested — which is exactly what
    // the old tool always got, since it never sent one.
    const { sign1, payload } = parts(fixture());
    const stripped = new Map(payload as Map<Encodable, Encodable>);
    stripped.set("nonce", null);
    const payloadBytes = encode(stripped);
    const rebuilt = { ...fixture(), attestation_doc_b64: cose(sign1[0]!, payloadBytes, sign1[3]!) };
    const check = parts(rebuilt).payload.get("nonce");
    mutationApplied(check === null, "the nonce survived being set to null");

    const v = verifyAttestationBody(rebuilt, fixtureNonce);
    expect(v.checks.nonce_echoed).toBe(false);
    expect(v.notes.join(" ")).toContain("carries no nonce");
    expect(v.notes.join(" ")).toContain("right now");
  });

  it("one flipped bit of PCR0 inside the document reddens signature_verified", () => {
    const { sign1, payload } = parts(fixture());
    const pcrs = payload.get("pcrs") as Map<number, Buffer>;
    const original = pcrs.get(0)!;
    const flipped = Buffer.from(original);
    flipped[0] ^= 0x01;
    mutationApplied(!flipped.equals(original), "the PCR0 bytes did not change");
    const mutatedPcrs = new Map(pcrs as Map<Encodable, Encodable>);
    mutatedPcrs.set(0, flipped);
    const mutatedPayload = new Map(payload as Map<Encodable, Encodable>);
    mutatedPayload.set("pcrs", mutatedPcrs);
    const rebuilt = {
      ...fixture(),
      attestation_doc_b64: cose(sign1[0]!, encode(mutatedPayload), sign1[3]!),
    };
    const after = parts(rebuilt).payload.get("pcrs") as Map<number, Buffer>;
    mutationApplied(!after.get(0)!.equals(original), "PCR0 survived the rebuild");

    const v = verifyAttestationBody(rebuilt, fixtureNonce);
    expect(v.checks.document_readable).toBe(true);
    expect(v.checks.signature_verified).toBe(false);
    expect(v.verified).toBe(false);
    expect(v.pcr0).toBe(flipped.toString("hex"));
  });

  it("an unreadable body is a could-not-check, with nothing claimed", () => {
    for (const body of [null, 42, {}, { attestation_doc_b64: "" }, { attestation_doc_b64: "!!!" }]) {
      const v = verifyAttestationBody(body, fixtureNonce);
      expect(v.verified).toBe(false);
      expect(v.pcr0).toBeUndefined();
      expect(typeof v.unreadable).toBe("string");
    }
  });
});

describe("verifyAttestationBody — a real forged chain", () => {
  const opensslWorks = (() => {
    try {
      execFileSync("openssl", ["version"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!opensslWorks)(
    "🔴 passes every other check and is caught ONLY by root_pinned",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "forge-"));
      const k = (n: string) => join(dir, n);
      const ossl = (...args: string[]) =>
        execFileSync("openssl", args, { stdio: "pipe", maxBuffer: 1 << 22 });

      for (const name of ["rootkey", "interkey", "leafkey"]) {
        ossl("ecparam", "-name", "secp384r1", "-genkey", "-noout", "-out", k(name));
      }
      // The forged root wears AWS's own subject name, so a check on the NAME would not
      // notice it. Only the fingerprint separates this from the real thing.
      ossl("req", "-new", "-x509", "-key", k("rootkey"), "-sha384", "-days", "2",
        "-out", k("rootcert"), "-subj", "/C=US/O=Amazon/OU=AWS/CN=aws.nitro-enclaves");
      writeFileSync(
        k("ext"),
        "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\n",
      );
      ossl("req", "-new", "-key", k("interkey"), "-sha384", "-out", k("intercsr"),
        "-subj", "/C=US/O=Amazon/OU=AWS/CN=forged.us-east-1.aws.nitro-enclaves");
      ossl("x509", "-req", "-in", k("intercsr"), "-CA", k("rootcert"), "-CAkey",
        k("rootkey"), "-sha384", "-days", "2", "-extfile", k("ext"), "-out", k("intercert"));
      ossl("req", "-new", "-key", k("leafkey"), "-sha384", "-out", k("leafcsr"),
        "-subj", "/C=US/O=Amazon/OU=AWS/CN=i-forged-enc0000.us-east-1.aws");
      ossl("x509", "-req", "-in", k("leafcsr"), "-CA", k("intercert"), "-CAkey",
        k("interkey"), "-sha384", "-days", "2", "-out", k("leafcert"));
      const der = (n: string) =>
        Buffer.from(ossl("x509", "-in", k(n), "-outform", "DER"));

      // The attacker's best move: claim the measurement that is really registered.
      const { payload: realPayload } = parts(fixture());
      const realPcr0 = (realPayload.get("pcrs") as Map<number, Buffer>).get(0)!;
      const nonce = randomBytes(16).toString("hex");

      const pcrs = new Map<Encodable, Encodable>();
      for (let i = 0; i < 16; i += 1) pcrs.set(i, i === 0 ? realPcr0 : Buffer.alloc(48));
      const payload = new Map<Encodable, Encodable>([
        ["module_id", "i-forged-enc0000"],
        ["digest", "SHA384"],
        ["timestamp", Date.now()],
        ["pcrs", pcrs],
        ["certificate", der("leafcert")],
        ["cabundle", [der("rootcert"), der("intercert")]],
        ["public_key", null],
        ["user_data", null],
        ["nonce", Buffer.from(nonce, "hex")],
      ]);
      const payloadBytes = encode(payload);
      const protectedBytes = encode(new Map<Encodable, Encodable>([[1, -35]]));
      writeFileSync(k("ss"), sigStructure(protectedBytes, payloadBytes));
      const derSig = Buffer.from(ossl("dgst", "-sha384", "-sign", k("leafkey"), k("ss")));
      // DER SEQUENCE{INTEGER r, INTEGER s} -> raw r||s, 48 bytes each.
      let at = derSig[1]! < 0x80 ? 2 : 2 + (derSig[1]! & 0x7f);
      const halves: Buffer[] = [];
      for (let n = 0; n < 2; n += 1) {
        const len = derSig[at + 1]!;
        let v = derSig.subarray(at + 2, at + 2 + len);
        while (v.length > 0 && v[0] === 0) v = v.subarray(1);
        halves.push(Buffer.concat([Buffer.alloc(48 - v.length), v]));
        at += 2 + len;
      }
      const rawSig = Buffer.concat(halves);
      mutationApplied(rawSig.length === 96, "the forged signature is not 96 bytes");

      const forged = {
        attestation_doc_b64: cose(protectedBytes, payloadBytes, rawSig),
        pcr0_sha384: realPcr0.toString("hex"),
        timestamp_ms: Date.now(),
      };
      mutationApplied(
        createHash("sha256").update(der("rootcert")).digest("hex") !== NITRO_ROOT_SHA256,
        "the forged root somehow matches the pinned fingerprint",
      );

      const v = verifyAttestationBody(forged, nonce);

      // Everything the attacker controls is green.
      expect(v.checks.document_readable).toBe(true);
      expect(v.checks.nonce_echoed).toBe(true);
      expect(v.checks.chain_verified).toBe(true);
      expect(v.checks.signature_verified).toBe(true);
      expect(v.pcr0).toBe(realPcr0.toString("hex"));
      // And the one thing they cannot forge is the one that catches them.
      expect(v.checks.root_pinned).toBe(false);
      expect(v.verified).toBe(false);
      expect(v.notes.join(" ")).toContain("not the pinned one");
    },
  );
});

describe("handleGetAttestation", () => {
  it("sends a fresh nonce in the query string", async () => {
    const seen: string[] = [];
    const cfg = {
      gatewayUrl: "https://signer.test",
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify(fixture()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    };
    await handleGetAttestation(cfg);
    await handleGetAttestation(cfg);
    expect(seen).toHaveLength(2);
    for (const url of seen) {
      expect(url).toMatch(/\/attestation\?nonce=[0-9a-f]{32}$/);
    }
    // 🔴 Two calls, two different nonces. A constant nonce would satisfy the regex above
    // and still leave a replay indistinguishable from a fresh document.
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("reports the verdict and refuses to call an unverified document evidence", async () => {
    const cfg = {
      gatewayUrl: "https://signer.test",
      // The gateway answers a document bound to somebody else's nonce.
      fetchImpl: (async () =>
        new Response(JSON.stringify(fixture()), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    };
    const res = await handleGetAttestation(cfg, () => "ab".repeat(16));
    const body = JSON.parse(res.content[0]!.text) as {
      verified: boolean;
      checks: Record<string, boolean>;
      proves: string[];
      do_not_trust_for: string[];
    };
    expect(body.verified).toBe(false);
    expect(body.checks.nonce_echoed).toBe(false);
    expect(body.proves).toEqual([]);
    expect(body.do_not_trust_for.join(" ")).toContain("it is none");
  });

  it("passes the verified document through with what it does and does not prove", async () => {
    const cfg = {
      gatewayUrl: "https://signer.test",
      fetchImpl: (async () =>
        new Response(JSON.stringify(fixture()), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    };
    const res = await handleGetAttestation(cfg, () => fixtureNonce);
    const body = JSON.parse(res.content[0]!.text) as {
      checks: Record<string, boolean>;
      pcr0: string;
      do_not_trust_for: string[];
      pinned_root_sha256: string;
    };
    expect(body.checks.nonce_echoed).toBe(true);
    expect(body.checks.signature_verified).toBe(true);
    expect(body.pcr0).toMatch(/^[0-9a-f]{96}$/);
    expect(body.pinned_root_sha256).toBe(NITRO_ROOT_SHA256);
    // The boundary travels with the answer, always — not only when something failed.
    expect(body.do_not_trust_for.join(" ")).toContain("published source");
  });
});
