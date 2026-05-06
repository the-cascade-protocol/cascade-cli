/**
 * Cascade Advisory Patch (CAP) — Detached JWS Verifier (TASK-4.3).
 *
 * Per decision tracker D-Q4, advisory v0.1 uses RFC 7515 detached JWS over
 * Ed25519 (alg "EdDSA") to envelope CAP files. We deliberately do NOT use
 * W3C Verifiable Credentials in v0.1 — that path is queued for v1.0 once
 * the surrounding trust-graph machinery (DID resolution, status lists) is
 * worth its weight. For v0.1, a compact detached JWS gives us:
 *
 *   - the signed body lives in the .ldpatch file (RDF, not JSON), and
 *   - the signature ships alongside in a sibling .jws file.
 *
 * The detached JWS compact serialization is `<header>..<signature>`
 * (base64url-encoded JSON header + ".." sentinel + base64url signature).
 * The body is signed but transmitted separately. See RFC 7515 Appendix F.
 *
 * Required header fields:
 *   - alg: "EdDSA"
 *   - iss: issuer IRI (matched against the trusted-issuer trust graph by
 *          the caller — for v0.1 we accept the public key directly)
 *   - iat: issued-at (unix epoch seconds)
 *   - cty: "application/x-cascade-advisory-patch"
 *
 * Optional header fields:
 *   - exp: expiration (unix epoch seconds)
 *   - kid: key identifier — useful when an issuer publishes multiple keys
 *
 * Key rotation: the public key array passed in MAY contain multiple keys
 * (current + archived). The verifier tries each in order; the first to
 * validate wins. This matches the operational reality that a TrustedIssuer
 * record carries multiple `cascade:publicKey` properties during a rotation
 * window.
 *
 * The verifier is pure: no network, no filesystem. The caller is responsible
 * for resolving `iss` to a key set via the per-pod trust graph (TASK-4.5/4.8).
 */

import { ed25519 } from '@noble/curves/ed25519.js';

/** Required `cty` header value for CAP detached JWS. */
export const CAP_JWS_CTY = 'application/x-cascade-advisory-patch';

/** Allowed signing algorithm for v0.1 (Ed25519 per D-Q4). */
export const CAP_JWS_ALG = 'EdDSA';

/** A parsed JWS protected header. */
export interface CapJwsHeader {
  alg: string;
  iss: string;
  iat: number;
  exp?: number;
  cty: string;
  kid?: string;
  /** Any additional header fields are preserved verbatim. */
  extra: Readonly<Record<string, unknown>>;
}

/** Result of a verification attempt. */
export type VerifyResult =
  | {
      valid: true;
      header: CapJwsHeader;
      /** Index into the publicKeys array of the key that matched. */
      keyIndex: number;
    }
  | {
      valid: false;
      /** Stable error code for programmatic handling. */
      code:
        | 'malformed_jws'
        | 'unsupported_alg'
        | 'wrong_cty'
        | 'missing_required_field'
        | 'expired'
        | 'signature_invalid'
        | 'no_keys'
        | 'key_invalid';
      /** Human-readable explanation. */
      message: string;
      /** Header (when parseable) — useful for debugging mismatched-key cases. */
      header?: CapJwsHeader;
    };

/**
 * Verify a detached JWS over `body` using the supplied trusted public keys.
 *
 * @param body         The CAP `.ldpatch` source as a UTF-8 string. This is
 *                     the signed payload — the JWS does not carry it.
 * @param jwsHeader    The base64url-encoded protected header (the part before
 *                     ".." in compact serialization).
 * @param jwsSignature The base64url-encoded signature (the part after "..").
 * @param publicKeys   Ordered list of trusted Ed25519 public keys (raw 32-byte
 *                     `Uint8Array` each — RFC 8032 encoding). MAY contain a
 *                     single key for non-rotation cases. Empty array yields a
 *                     `no_keys` failure.
 * @param now          Unix epoch seconds for `exp` checks. Defaults to system
 *                     time; tests pass a fixed value for determinism.
 */
export function verifyDetachedJws(
  body: string,
  jwsHeader: string,
  jwsSignature: string,
  publicKeys: ReadonlyArray<Uint8Array>,
  now: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  // ── 1. Parse the protected header ─────────────────────────────────────
  let headerJson: string;
  try {
    headerJson = utf8FromBase64Url(jwsHeader);
  } catch (e) {
    return {
      valid: false,
      code: 'malformed_jws',
      message: `JWS header is not valid base64url: ${(e as Error).message}`,
    };
  }
  let headerRaw: Record<string, unknown>;
  try {
    headerRaw = JSON.parse(headerJson) as Record<string, unknown>;
  } catch (e) {
    return {
      valid: false,
      code: 'malformed_jws',
      message: `JWS header is not valid JSON: ${(e as Error).message}`,
    };
  }
  if (typeof headerRaw !== 'object' || headerRaw === null || Array.isArray(headerRaw)) {
    return {
      valid: false,
      code: 'malformed_jws',
      message: 'JWS header must decode to a JSON object',
    };
  }

  // ── 2. Validate required header fields ───────────────────────────────
  const alg = headerRaw.alg;
  if (typeof alg !== 'string') {
    return {
      valid: false,
      code: 'missing_required_field',
      message: 'JWS header missing required "alg"',
    };
  }
  if (alg !== CAP_JWS_ALG) {
    return {
      valid: false,
      code: 'unsupported_alg',
      message: `JWS alg "${alg}" not supported for CAP v0.1; expected "${CAP_JWS_ALG}" (Ed25519)`,
    };
  }
  const cty = headerRaw.cty;
  if (typeof cty !== 'string') {
    return {
      valid: false,
      code: 'missing_required_field',
      message: 'JWS header missing required "cty"',
    };
  }
  if (cty !== CAP_JWS_CTY) {
    return {
      valid: false,
      code: 'wrong_cty',
      message: `JWS cty "${cty}" is not a CAP advisory; expected "${CAP_JWS_CTY}"`,
    };
  }
  const iss = headerRaw.iss;
  if (typeof iss !== 'string' || iss.length === 0) {
    return {
      valid: false,
      code: 'missing_required_field',
      message: 'JWS header missing required "iss" (issuer IRI)',
    };
  }
  const iat = headerRaw.iat;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) {
    return {
      valid: false,
      code: 'missing_required_field',
      message: 'JWS header missing required "iat" (unix-epoch issued-at)',
    };
  }

  // exp is optional but if present, must be a number and in the future.
  let exp: number | undefined;
  if (headerRaw.exp !== undefined) {
    if (typeof headerRaw.exp !== 'number' || !Number.isFinite(headerRaw.exp)) {
      return {
        valid: false,
        code: 'missing_required_field',
        message: 'JWS header "exp" must be a number if present',
      };
    }
    exp = headerRaw.exp;
  }

  const kid = typeof headerRaw.kid === 'string' ? headerRaw.kid : undefined;
  const known = new Set(['alg', 'iss', 'iat', 'exp', 'cty', 'kid']);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headerRaw)) {
    if (!known.has(k)) extra[k] = v;
  }
  const header: CapJwsHeader = { alg, iss, iat, exp, cty, kid, extra };

  // ── 3. Expiry check (before signature — cheaper) ──────────────────────
  if (exp !== undefined && exp < now) {
    return {
      valid: false,
      code: 'expired',
      message: `JWS expired: exp=${exp} < now=${now}`,
      header,
    };
  }

  // ── 4. Signature decoding ─────────────────────────────────────────────
  if (publicKeys.length === 0) {
    return {
      valid: false,
      code: 'no_keys',
      message:
        'No trusted public keys provided for issuer; do not apply this advisory until ' +
        'the issuer is added to the pod trust graph',
      header,
    };
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = bytesFromBase64Url(jwsSignature);
  } catch (e) {
    return {
      valid: false,
      code: 'malformed_jws',
      message: `JWS signature is not valid base64url: ${(e as Error).message}`,
      header,
    };
  }
  if (signatureBytes.length !== 64) {
    return {
      valid: false,
      code: 'malformed_jws',
      message: `Ed25519 signature must be 64 bytes; got ${signatureBytes.length}`,
      header,
    };
  }

  // ── 5. Compute the JWS Signing Input ──────────────────────────────────
  // Per RFC 7515 §5.1: ASCII(BASE64URL(header) || '.' || BASE64URL(payload))
  // For detached content (Appendix F), we use the unencoded body directly:
  // the signing input is `BASE64URL(header) || '.' || BASE64URL(payload)`,
  // and we base64url-encode the body ourselves to construct the input.
  const bodyBytes = new TextEncoder().encode(body);
  const bodyB64 = base64UrlFromBytes(bodyBytes);
  const signingInput = `${jwsHeader}.${bodyB64}`;
  const signingInputBytes = new TextEncoder().encode(signingInput);

  // ── 6. Try each public key in order (key rotation support) ────────────
  for (let i = 0; i < publicKeys.length; i++) {
    const key = publicKeys[i]!;
    if (key.length !== 32) {
      // Skip malformed keys but remember in case ALL are malformed.
      continue;
    }
    let verified = false;
    try {
      verified = ed25519.verify(signatureBytes, signingInputBytes, key);
    } catch {
      // ed25519.verify can throw on certain malformed inputs; treat as not-valid.
      verified = false;
    }
    if (verified) {
      return { valid: true, header, keyIndex: i };
    }
  }

  // No key matched — but distinguish "all keys malformed" from "valid keys, bad sig".
  const anyValidKey = publicKeys.some((k) => k.length === 32);
  if (!anyValidKey) {
    return {
      valid: false,
      code: 'key_invalid',
      message: `All ${publicKeys.length} provided public keys are malformed (Ed25519 keys must be 32 bytes)`,
      header,
    };
  }
  return {
    valid: false,
    code: 'signature_invalid',
    message:
      'JWS signature did not verify against any of the trusted issuer keys; ' +
      'do not apply. The advisory body, signature, or trusted-key set may be tampered or stale.',
    header,
  };
}

/**
 * Parse a complete RFC 7515 compact detached JWS string of the form
 * `<header>..<signature>` (the empty middle segment indicates detached payload).
 *
 * Returns `{ header, signature }` strings on success, or `null` if the input is
 * not in the expected three-part format.
 */
export function parseDetachedJwsCompact(
  jws: string,
): { header: string; signature: string } | null {
  const parts = jws.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  if (header == null || signature == null) return null;
  // Detached form: middle segment must be empty.
  if (body !== '') return null;
  if (header.length === 0 || signature.length === 0) return null;
  return { header, signature };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Base64url helpers                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/** Encode bytes as base64url (RFC 4648 §5, no padding). */
export function base64UrlFromBytes(bytes: Uint8Array): string {
  // Node Buffer is fine for this — we're already in a Node-targeted CLI.
  return Buffer.from(bytes).toString('base64url');
}

/** Decode a base64url string to bytes. Throws on invalid input. */
export function bytesFromBase64Url(s: string): Uint8Array {
  // Buffer.from(..., 'base64url') is permissive about both base64 and base64url
  // input; we therefore do a sanity check first.
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new Error('contains non-base64url characters');
  }
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

/** Decode a base64url string to a UTF-8 JS string. */
function utf8FromBase64Url(s: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytesFromBase64Url(s));
}
