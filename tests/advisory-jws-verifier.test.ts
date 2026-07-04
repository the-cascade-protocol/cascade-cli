/**
 * Tests for the CAP detached JWS verifier (TASK-4.3).
 *
 * Acceptance:
 *   - Detached JWS over the advisory body verifies against a trusted issuer key.
 *   - Tampered body / tampered signature / wrong key produce clear failures.
 *   - Expired (exp < now) JWS rejected.
 *   - Missing required header fields rejected.
 *   - Multiple keys per issuer accepted (key rotation).
 *
 * The tests sign fixtures locally with @noble/curves so they're hermetic — no
 * pre-baked golden signatures that would break if the test fixtures change.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  verifyDetachedJws,
  parseDetachedJwsCompact,
  base64UrlFromBytes,
  CAP_JWS_CTY,
} from '../src/lib/advisory/jws-verifier.js';

const EXAMPLES_DIR = path.resolve(
  os.homedir(),
  'Development/cascadeprotocol.org/drafts/advisory-v1',
);

// The example advisory patches (*.ldpatch) referenced below live in the
// cascadeprotocol.org sibling repo (~/Development/cascadeprotocol.org/drafts/
// advisory-v1). That repo is private and its drafts/ fixtures are not committed,
// so they cannot be provisioned in CI. Quarantine the fixture-dependent blocks
// when the files are absent; they still run locally when the sibling is checked
// out. Re-enable in CI once the fixtures are moved in-repo or provisioned.
const FIXTURES_AVAILABLE =
  fs.existsSync(path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch')) &&
  fs.existsSync(path.join(EXAMPLES_DIR, 'example-cpic-cyp2c19-warfarin.ldpatch'));

/** Sign `body` with `secretKey` under a given header; returns {header, signature} b64url strings. */
function signDetached(
  body: string,
  secretKey: Uint8Array,
  headerOverrides: Record<string, unknown> = {},
): { header: string; signature: string; publicKey: Uint8Array } {
  const header = {
    alg: 'EdDSA',
    iss: 'https://issuer.example/keys/1',
    iat: 1_700_000_000,
    cty: CAP_JWS_CTY,
    ...headerOverrides,
  };
  const headerJson = JSON.stringify(header);
  const headerB64 = base64UrlFromBytes(new TextEncoder().encode(headerJson));
  const bodyB64 = base64UrlFromBytes(new TextEncoder().encode(body));
  const signingInput = new TextEncoder().encode(`${headerB64}.${bodyB64}`);
  const sig = ed25519.sign(signingInput, secretKey);
  const sigB64 = base64UrlFromBytes(sig);
  const publicKey = ed25519.getPublicKey(secretKey);
  return { header: headerB64, signature: sigB64, publicKey };
}

describe.skipIf(!FIXTURES_AVAILABLE)('CAP detached JWS verifier — happy path', () => {
  it('verifies a valid detached JWS over the BRCA2 reclassification example', () => {
    const body = fs.readFileSync(
      path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch'),
      'utf8',
    );
    const { secretKey } = ed25519.keygen();
    const { header, signature, publicKey } = signDetached(body, secretKey);
    const result = verifyDetachedJws(body, header, signature, [publicKey]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.keyIndex).toBe(0);
      expect(result.header.alg).toBe('EdDSA');
      expect(result.header.cty).toBe(CAP_JWS_CTY);
    }
  });

  it('verifies a valid detached JWS over the CYP2C19/warfarin example', () => {
    const body = fs.readFileSync(
      path.join(EXAMPLES_DIR, 'example-cpic-cyp2c19-warfarin.ldpatch'),
      'utf8',
    );
    const { secretKey } = ed25519.keygen();
    const { header, signature, publicKey } = signDetached(body, secretKey);
    const result = verifyDetachedJws(body, header, signature, [publicKey]);
    expect(result.valid).toBe(true);
  });
});

describe('CAP detached JWS verifier — failure modes', () => {
  it('rejects a tampered body', () => {
    const body = 'original body';
    const { secretKey, publicKey } = (() => {
      const k = ed25519.keygen();
      return { secretKey: k.secretKey, publicKey: k.publicKey };
    })();
    const { header, signature } = signDetached(body, secretKey);
    const tamperedBody = body + ' but altered';
    const result = verifyDetachedJws(tamperedBody, header, signature, [publicKey]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('signature_invalid');
      expect(result.message).toMatch(/do not apply/i);
    }
  });

  it('rejects a tampered signature', () => {
    const body = 'some advisory body';
    const { secretKey } = ed25519.keygen();
    const { header, signature, publicKey } = signDetached(body, secretKey);
    // Flip a byte in the middle of the signature.
    const sigBytes = Buffer.from(signature, 'base64url');
    sigBytes[10] = sigBytes[10]! ^ 0xff;
    const tamperedSig = sigBytes.toString('base64url');
    const result = verifyDetachedJws(body, header, tamperedSig, [publicKey]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('signature_invalid');
    }
  });

  it('rejects when verified against the wrong key', () => {
    const body = 'some advisory body';
    const { secretKey } = ed25519.keygen();
    const { header, signature } = signDetached(body, secretKey);
    const wrongKey = ed25519.keygen().publicKey;
    const result = verifyDetachedJws(body, header, signature, [wrongKey]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe('signature_invalid');
  });

  it('rejects an expired JWS', () => {
    const body = 'expired advisory';
    const { secretKey } = ed25519.keygen();
    const { header, signature, publicKey } = signDetached(body, secretKey, {
      exp: 1_700_000_500,
    });
    const result = verifyDetachedJws(
      body,
      header,
      signature,
      [publicKey],
      1_800_000_000, // now is far after exp
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('expired');
      expect(result.header?.exp).toBe(1_700_000_500);
    }
  });

  it('accepts an unexpired JWS with exp set', () => {
    const body = 'unexpired advisory';
    const { secretKey } = ed25519.keygen();
    const { header, signature, publicKey } = signDetached(body, secretKey, {
      exp: 1_900_000_000,
    });
    const result = verifyDetachedJws(body, header, signature, [publicKey], 1_700_000_100);
    expect(result.valid).toBe(true);
  });

  it.each([
    ['alg', { alg: undefined }, 'missing_required_field'],
    ['iss', { iss: undefined }, 'missing_required_field'],
    ['iat', { iat: undefined }, 'missing_required_field'],
    ['cty', { cty: undefined }, 'missing_required_field'],
  ])('rejects header missing required field %s', (_field, override, expectedCode) => {
    const body = 'body';
    const { secretKey, publicKey } = ed25519.keygen();
    // Hand-build header to allow `undefined` (which JSON.stringify drops).
    const baseHeader: Record<string, unknown> = {
      alg: 'EdDSA',
      iss: 'https://issuer.example',
      iat: 1_700_000_000,
      cty: CAP_JWS_CTY,
    };
    for (const [k, v] of Object.entries(override)) {
      if (v === undefined) delete baseHeader[k];
      else baseHeader[k] = v;
    }
    const headerB64 = base64UrlFromBytes(
      new TextEncoder().encode(JSON.stringify(baseHeader)),
    );
    const bodyB64 = base64UrlFromBytes(new TextEncoder().encode(body));
    const sig = ed25519.sign(
      new TextEncoder().encode(`${headerB64}.${bodyB64}`),
      secretKey,
    );
    const result = verifyDetachedJws(body, headerB64, base64UrlFromBytes(sig), [publicKey]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(expectedCode);
  });

  it('rejects a non-EdDSA alg', () => {
    const body = 'body';
    const { secretKey, publicKey } = ed25519.keygen();
    const { header, signature } = signDetached(body, secretKey, { alg: 'RS256' });
    const result = verifyDetachedJws(body, header, signature, [publicKey]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe('unsupported_alg');
  });

  it('rejects a wrong cty', () => {
    const body = 'body';
    const { secretKey, publicKey } = ed25519.keygen();
    const { header, signature } = signDetached(body, secretKey, { cty: 'application/json' });
    const result = verifyDetachedJws(body, header, signature, [publicKey]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe('wrong_cty');
  });

  it('rejects when no keys are provided', () => {
    const body = 'body';
    const { secretKey } = ed25519.keygen();
    const { header, signature } = signDetached(body, secretKey);
    const result = verifyDetachedJws(body, header, signature, []);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe('no_keys');
  });

  it('rejects malformed base64url in header', () => {
    const result = verifyDetachedJws('body', 'not_valid_base64url!!!', 'sig', [
      ed25519.keygen().publicKey,
    ]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe('malformed_jws');
  });

  it('rejects a signature of the wrong length', () => {
    const body = 'body';
    const { secretKey, publicKey } = ed25519.keygen();
    const { header } = signDetached(body, secretKey);
    const shortSig = base64UrlFromBytes(new Uint8Array(32)); // not 64 bytes
    const result = verifyDetachedJws(body, header, shortSig, [publicKey]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe('malformed_jws');
  });
});

describe('CAP detached JWS verifier — key rotation', () => {
  it('accepts when the second of two keys validates the signature', () => {
    const body = 'rotated advisory';
    const { secretKey, publicKey: currentKey } = ed25519.keygen();
    const { publicKey: archivedKey } = ed25519.keygen();
    const { header, signature } = signDetached(body, secretKey);
    // Archived (wrong) key first, current (correct) key second.
    const result = verifyDetachedJws(body, header, signature, [archivedKey, currentKey]);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.keyIndex).toBe(1);
  });

  it('returns the index of the matching key', () => {
    const body = 'body';
    const { secretKey: k1Sk, publicKey: k1Pk } = ed25519.keygen();
    const { publicKey: k2Pk } = ed25519.keygen();
    const { publicKey: k3Pk } = ed25519.keygen();
    const { header, signature } = signDetached(body, k1Sk);
    const result = verifyDetachedJws(body, header, signature, [k2Pk, k3Pk, k1Pk]);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.keyIndex).toBe(2);
  });

  it('skips malformed keys but continues to try valid ones', () => {
    const body = 'body';
    const { secretKey, publicKey } = ed25519.keygen();
    const { header, signature } = signDetached(body, secretKey);
    const malformed = new Uint8Array(16); // wrong length
    const result = verifyDetachedJws(body, header, signature, [malformed, publicKey]);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.keyIndex).toBe(1);
  });

  it('reports key_invalid when ALL keys are malformed', () => {
    const body = 'body';
    const { secretKey } = ed25519.keygen();
    const { header, signature } = signDetached(body, secretKey);
    const result = verifyDetachedJws(body, header, signature, [
      new Uint8Array(16),
      new Uint8Array(8),
    ]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe('key_invalid');
  });
});

describe('parseDetachedJwsCompact', () => {
  it('parses a valid detached compact form', () => {
    const parsed = parseDetachedJwsCompact('hdr..sig');
    expect(parsed).not.toBeNull();
    expect(parsed!.header).toBe('hdr');
    expect(parsed!.signature).toBe('sig');
  });

  it('rejects a non-detached (attached) form', () => {
    expect(parseDetachedJwsCompact('hdr.body.sig')).toBeNull();
  });

  it('rejects a form with too few segments', () => {
    expect(parseDetachedJwsCompact('hdr.sig')).toBeNull();
  });

  it('rejects empty header or signature', () => {
    expect(parseDetachedJwsCompact('..sig')).toBeNull();
    expect(parseDetachedJwsCompact('hdr..')).toBeNull();
  });
});
