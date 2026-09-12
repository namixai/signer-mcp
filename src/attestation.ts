/**
 * Verification of an AWS Nitro attestation document — with no dependencies.
 *
 * Why this file exists, stated plainly because the reason is the whole point.
 *
 * `get_attestation` used to call `/attestation` with no parameters, hand the raw JSON to
 * the calling agent, and describe itself as proof that "the code CURRENTLY signing your
 * orders matches the published source". Neither half held:
 *
 *   * No nonce was sent, so the document was bound to nothing. A recording of last
 *     year's attestation is indistinguishable, from that client, from a fresh one — and
 *     the word "currently" is exactly what a nonce buys.
 *   * Nothing was verified. Not the hardware signature, not the certificate chain, not
 *     the root. The tool forwarded a blob and an assertion.
 *
 * This is the only surface a third-party AI agent consumes, which makes it the worst
 * place in the product to keep a decorative verifier. So the work happens here: a fresh
 * nonce goes out, and the document that comes back is opened.
 *
 * WHAT IS CHECKED, each one able to go red on its own:
 *
 *   document_readable  the body decodes as a COSE_Sign1 with an ES384 header, and every
 *                      field this code later touches is present and of the right type
 *   nonce_echoed       the nonce INSIDE the document is the one we just generated
 *   root_pinned        the root certificate is the one pinned below, by SHA-256
 *   chain_verified     leaf <- intermediates <- root, each link signed by the next
 *   signature_verified ES384 over the COSE Sig_structure under the leaf's public key
 *
 * WHAT IS NOT CHECKED, because a verifier that overstates itself is worse than none:
 *
 *   * That PCR0 corresponds to the published source. That is a separate step and it is
 *     not ours to assert — a reader rebuilds the image from the public clone and
 *     compares, or asks the on-chain registry. This file returns the measurement; it does
 *     not vouch for what the measurement means.
 *   * Certificate expiry beyond what the chain check itself enforces, and revocation.
 */
import { createHash, verify as cryptoVerify, X509Certificate } from "node:crypto";

/** COSE algorithm identifier for ECDSA with SHA-384. */
const ES384 = -35;

/**
 * 🔴 THE TRUST ANCHOR, PINNED.
 *
 * Without this the rest is theatre against the one attacker who matters: whoever answers
 * on `SIGNER_GATEWAY_URL` can mint their own CA — under AWS's own subject name, so a name
 * check would not notice — sign their own chain, sign a document carrying any PCR0 they
 * like, echo our nonce, and every other check above goes green.
 *
 * What this value is, exactly: the SHA-256 of the DER of the root certificate that Nitro
 * attestation documents from our enclaves chain to, recorded 12 September 2026. It is not
 * something this file can prove is AWS's. Anyone who would rather not take our word for
 * one constant checks it once against AWS's own published root:
 *
 *   curl -sO https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip
 *   unzip -p AWS_NitroEnclaves_Root-G1.zip > aws-nitro-root
 *   openssl x509 -in aws-nitro-root -outform DER | shasum -a 256
 *
 * After that comparison the pin is theirs rather than ours. There is deliberately NO
 * environment variable to override it: an agent that can be talked into relaxing its own
 * trust anchor has none.
 */
export const NITRO_ROOT_SHA256 =
  "641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b";

export const NITRO_ROOT_SOURCE =
  "https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip";

export type AttestationCheck =
  | "document_readable"
  | "nonce_echoed"
  | "root_pinned"
  | "chain_verified"
  | "signature_verified";

export interface AttestationVerdict {
  /** True only when every check below passed. */
  verified: boolean;
  checks: Record<AttestationCheck, boolean>;
  /** Present when the document was readable: PCR0 taken from the SIGNED bytes. */
  pcr0?: string;
  pcr1?: string;
  pcr2?: string;
  moduleId?: string;
  timestampMs?: number;
  nonceSent: string;
  nonceInDocument?: string;
  rootSha256?: string;
  /** Set when a check could not be performed at all, as opposed to failing. */
  unreadable?: string;
  notes: string[];
}

// ── CBOR, only as much of it as an attestation document uses ──

type CborValue =
  | number
  | string
  | Buffer
  | boolean
  | null
  | CborValue[]
  | Map<CborValue, CborValue>;

/**
 * Decode one CBOR item at `at`. Throws on anything it does not support; every caller in
 * this file is inside a try, and the failure becomes a named refusal rather than a stack.
 */
function decodeAt(b: Buffer, at: number): [CborValue, number] {
  if (at >= b.length) throw new Error("truncated");
  const major = b[at]! >> 5;
  const minor = b[at]! & 0x1f;
  let i = at + 1;
  let val: number | null;
  if (minor < 24) {
    val = minor;
  } else if (minor === 24) {
    val = b[i]!;
    i += 1;
  } else if (minor === 25) {
    val = b.readUInt16BE(i);
    i += 2;
  } else if (minor === 26) {
    val = b.readUInt32BE(i);
    i += 4;
  } else if (minor === 27) {
    val = Number(b.readBigUInt64BE(i));
    i += 8;
  } else if (minor === 31) {
    val = null; // indefinite length
  } else {
    throw new Error(`unsupported additional info ${minor}`);
  }

  switch (major) {
    case 0:
      return [val!, i];
    case 1:
      return [-1 - val!, i];
    case 2:
    case 3: {
      if (val === null) {
        const parts: CborValue[] = [];
        while (b[i] !== 0xff) {
          const [chunk, next] = decodeAt(b, i);
          parts.push(chunk);
          i = next;
        }
        i += 1;
        return major === 2
          ? [Buffer.concat(parts as Buffer[]), i]
          : [(parts as string[]).join(""), i];
      }
      const slice = b.subarray(i, i + val);
      if (slice.length !== val) throw new Error("truncated string");
      i += val;
      return major === 2 ? [Buffer.from(slice), i] : [slice.toString("utf8"), i];
    }
    case 4: {
      const out: CborValue[] = [];
      if (val === null) {
        while (b[i] !== 0xff) {
          const [item, next] = decodeAt(b, i);
          out.push(item);
          i = next;
        }
        return [out, i + 1];
      }
      for (let k = 0; k < val; k += 1) {
        const [item, next] = decodeAt(b, i);
        out.push(item);
        i = next;
      }
      return [out, i];
    }
    case 5: {
      const out = new Map<CborValue, CborValue>();
      if (val === null) {
        while (b[i] !== 0xff) {
          const [key, afterKey] = decodeAt(b, i);
          const [value, afterValue] = decodeAt(b, afterKey);
          out.set(key, value);
          i = afterValue;
        }
        return [out, i + 1];
      }
      for (let k = 0; k < val; k += 1) {
        const [key, afterKey] = decodeAt(b, i);
        const [value, afterValue] = decodeAt(b, afterKey);
        out.set(key, value);
        i = afterValue;
      }
      return [out, i];
    }
    case 6: {
      // 🔴 A TAG IS NOT A DEFECT. RFC 8152 says a COSE_Sign1 may be wrapped in tag 18,
      // and `0xd2 0x84 …` is a perfectly legal encoding of exactly the document we read
      // today as `0x84 …`. Until this branch existed, a tagged document was refused with
      // "unsupported major type 6" — we would have called a valid attestation unreadable
      // and blamed the gateway. Our own gateway sends it untagged, which is why nothing
      // broke and why nobody noticed.
      //
      // Only tag 18 is unwrapped, and only at the outermost level as a consequence of
      // where this is called. Any other tag is refused BY NUMBER rather than swallowed:
      // an attestation document has no business carrying one, and silently ignoring
      // semantics we do not understand is how a parser starts agreeing to things.
      if (val !== 18) throw new Error(`unexpected CBOR tag ${val}`);
      return decodeAt(b, i);
    }
    case 7: {
      if (minor === 20) return [false, i];
      if (minor === 21) return [true, i];
      if (minor === 22 || minor === 23) return [null, i];
      // Floats are major 7 with minor 25/26/27. Refused deliberately: nothing in an
      // attestation document is a float, and a number that arrives as one is a signal
      // about the producer, not a value to accept.
      throw new Error(`unsupported simple or float value (minor ${minor})`);
    }
    default:
      throw new Error(`unsupported major type ${major}`);
  }
}

export function decodeCbor(b: Buffer): CborValue {
  const [value] = decodeAt(b, 0);
  return value;
}

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/**
 * The bytes a COSE_Sign1 signature is actually over:
 * `["Signature1", protected, external_aad, payload]`.
 *
 * 🔴 The protected header and payload go in as the ORIGINAL byte strings, never
 * re-encoded from the decoded objects. Re-serialising produces different bytes and the
 * signature stops matching for a reason that looks like tampering.
 */
export function sigStructure(protectedBytes: Buffer, payloadBytes: Buffer): Buffer {
  const label = Buffer.from("Signature1", "utf8");
  const bstr = (x: Buffer) => Buffer.concat([head(2, x.length), x]);
  return Buffer.concat([
    head(4, 4),
    head(3, label.length),
    label,
    bstr(protectedBytes),
    bstr(Buffer.alloc(0)),
    bstr(payloadBytes),
  ]);
}

function isBuffer(v: unknown): v is Buffer {
  return Buffer.isBuffer(v);
}

/**
 * Verify an attestation body against the nonce we sent.
 *
 * Never throws: an unreadable document comes back with `unreadable` set and every check
 * false, which the caller must report as "could not check" rather than as a failed
 * enclave. A document that is readable but wrong comes back with the specific check false.
 */
export function verifyAttestationBody(
  body: unknown,
  nonceSent: string,
): AttestationVerdict {
  const checks: Record<AttestationCheck, boolean> = {
    document_readable: false,
    nonce_echoed: false,
    root_pinned: false,
    chain_verified: false,
    signature_verified: false,
  };
  const notes: string[] = [];
  const fail = (why: string): AttestationVerdict => ({
    verified: false,
    checks,
    nonceSent,
    unreadable: why,
    notes,
  });

  if (typeof body !== "object" || body === null) {
    return fail("the gateway response is not a JSON object");
  }
  const b64 = (body as Record<string, unknown>).attestation_doc_b64;
  if (typeof b64 !== "string" || b64.length === 0) {
    return fail("the response carries no `attestation_doc_b64` string");
  }

  let sign1: CborValue[];
  let payload: Map<CborValue, CborValue>;
  let raw: Buffer;
  try {
    raw = Buffer.from(b64, "base64");
    const decoded = decodeCbor(raw);
    if (!Array.isArray(decoded) || decoded.length !== 4) {
      return fail("the document is not a 4-item COSE_Sign1 array");
    }
    sign1 = decoded;
    if (!isBuffer(sign1[0]) || !isBuffer(sign1[2]) || !isBuffer(sign1[3])) {
      return fail("COSE_Sign1 fields 0/2/3 must be byte strings");
    }
    const header = decodeCbor(sign1[0]);
    if (!(header instanceof Map) || header.get(1) !== ES384) {
      return fail(
        `the protected header does not declare ES384 (${ES384}); a document we cannot ` +
          `interpret is not a document we will vouch for`,
      );
    }
    const decodedPayload = decodeCbor(sign1[2]);
    if (!(decodedPayload instanceof Map)) {
      return fail("the payload is not a CBOR map");
    }
    payload = decodedPayload;
  } catch (err) {
    return fail(`the document could not be decoded (${(err as Error).name})`);
  }

  const pcrs = payload.get("pcrs");
  const pcr0Raw = pcrs instanceof Map ? pcrs.get(0) : undefined;
  if (!(pcrs instanceof Map) || !isBuffer(pcr0Raw) || pcr0Raw.length !== 48) {
    return fail("pcrs[0] is missing, not a byte string, or not 48 bytes (SHA-384)");
  }
  const leafDer = payload.get("certificate");
  if (!isBuffer(leafDer) || leafDer.length === 0) {
    return fail("`certificate` is missing or is not a byte string");
  }
  const bundle = payload.get("cabundle");
  if (
    !Array.isArray(bundle) ||
    bundle.length === 0 ||
    !bundle.every((c) => isBuffer(c) && c.length > 0)
  ) {
    return fail("`cabundle` is missing, empty, or is not a list of byte strings");
  }
  const signature = sign1[3] as Buffer;
  if (signature.length === 0 || signature.length % 2 !== 0) {
    return fail(
      `the signature is ${signature.length} bytes, which cannot split into r and s`,
    );
  }
  const nonceField = payload.get("nonce");
  if (nonceField !== null && nonceField !== undefined && !isBuffer(nonceField)) {
    return fail("`nonce` is present but is not a byte string");
  }

  checks.document_readable = true;

  const pcrHex = (i: number) => {
    const v = pcrs.get(i);
    return isBuffer(v) ? v.toString("hex") : undefined;
  };
  const moduleId = payload.get("module_id");
  const timestamp = payload.get("timestamp");
  const nonceInDocument = isBuffer(nonceField) ? nonceField.toString("hex") : "";

  // 🔴 The nonce is what makes the answer about NOW. Without it a replayed recording of
  // an older document is indistinguishable from a fresh one, and "currently" is unearned.
  checks.nonce_echoed =
    nonceInDocument.length > 0 && nonceInDocument === nonceSent.toLowerCase();
  if (!checks.nonce_echoed) {
    notes.push(
      nonceInDocument.length === 0
        ? "the document carries no nonce: this gateway did not bind the document to our " +
          "request, so it is not evidence about the code running right now"
        : "the nonce inside the document is not the one we sent",
    );
  }

  const rootDer = bundle[0] as Buffer;
  const rootSha256 = createHash("sha256").update(rootDer).digest("hex");
  checks.root_pinned = rootSha256 === NITRO_ROOT_SHA256;
  if (!checks.root_pinned) {
    notes.push(
      `the root certificate is not the pinned one: expected ${NITRO_ROOT_SHA256}, got ` +
        `${rootSha256}. A chain can be perfectly consistent with a root an attacker ` +
        `minted, so nothing else here means much until this line is green`,
    );
  }

  try {
    const root = new X509Certificate(rootDer);
    const leaf = new X509Certificate(leafDer);
    const intermediates = bundle.slice(1).map((der) => new X509Certificate(der as Buffer));
    // Root is self-signed; then leaf <- last intermediate <- ... <- root.
    let chainOk = root.verify(root.publicKey);
    let child = leaf;
    for (let i = intermediates.length - 1; i >= 0; i -= 1) {
      const parent = intermediates[i]!;
      chainOk = chainOk && child.checkIssued(parent) && child.verify(parent.publicKey);
      child = parent;
    }
    chainOk = chainOk && child.checkIssued(root) && child.verify(root.publicKey);
    checks.chain_verified = chainOk;
    if (!chainOk) notes.push("the certificate chain does not lead to the root");

    // 🔴 `ieee-p1363` because COSE carries the signature as raw r||s, while Node's
    // default expects DER. With the default this verification fails on a perfectly good
    // document — a false red, which teaches a reader to ignore reds.
    checks.signature_verified = cryptoVerify(
      "sha384",
      sigStructure(sign1[0] as Buffer, sign1[2] as Buffer),
      { key: leaf.publicKey, dsaEncoding: "ieee-p1363" },
      signature,
    );
    if (!checks.signature_verified) {
      notes.push(
        "the hardware signature does not cover these bytes: the document was altered " +
          "after signing, or it was never signed by the key in its own certificate",
      );
    }
  } catch (err) {
    notes.push(
      `the certificates could not be read (${(err as Error).name}), so the chain and ` +
        `signature could not be checked at all`,
    );
  }

  const verdict: AttestationVerdict = {
    verified: Object.values(checks).every(Boolean),
    checks,
    pcr0: pcrHex(0),
    nonceSent,
    nonceInDocument,
    rootSha256,
    notes,
  };
  const pcr1 = pcrHex(1);
  const pcr2 = pcrHex(2);
  if (pcr1 !== undefined) verdict.pcr1 = pcr1;
  if (pcr2 !== undefined) verdict.pcr2 = pcr2;
  if (typeof moduleId === "string") verdict.moduleId = moduleId;
  if (typeof timestamp === "number") verdict.timestampMs = timestamp;
  return verdict;
}
