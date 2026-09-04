/**
 * The shared conformance identity vectors, executed against this repository's
 * identity functions.
 *
 * WHY THIS FILE EXISTS. `conformance/fixtures/deterministic-ids/test-vectors.json`
 * is the cross-implementation contract for CDP-UUID: the primitive digest, the
 * identity string, the canonical form of a set-valued field, and the order of
 * the identity keys. cascade-cli mints those identifiers and had never read the
 * file. Its identity behaviour was pinned only by golden values written inside
 * this repository, which is a test of self-consistency: it catches a drift from
 * yesterday's cascade-cli, and cannot catch a disagreement with the protocol or
 * with another implementation, which is the failure that actually splits a
 * record across two tools.
 *
 * WHAT IT ASSERTS. Every group in the file, including `keyOrderVectors` and the
 * member-order entries in `multiValuedFieldVectors` — not a chosen subset, so a
 * vector added upstream arrives here as a failing test rather than as silence.
 *
 * HOW ARRAY-VALUED FIELDS ARE FED. `contentHashedUri` here takes
 * `Record<string, string | undefined>`; the canonical form of a set-valued
 * field is applied by the CALLER, through `canonicalSetKey`, because the
 * separator is a per-site parameter in this repository (',' at two sites, ';'
 * at one, each kept because changing it would re-mint every identifier the site
 * ever produced). So a vector whose `contentFields` holds an array is fed
 * through `canonicalSetKey(members, ',')` first — the recommended separator,
 * which is what the file's `expectedUri` values are computed with — and the
 * composition of the two functions is what the vector measures. That
 * composition is exactly what every real call site does.
 *
 * PATH RESOLUTION. The conformance fixture directory is resolved through the
 * `conformance` sibling symlink, and `CASCADE_CONFORMANCE_DIR` overrides it for
 * a run against a conformance feature branch.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deterministicUuid,
  contentHashedUri,
  canonicalSetKey,
} from '../src/lib/fhir-converter/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_DIR =
  process.env.CASCADE_CONFORMANCE_DIR ?? path.resolve(HERE, '..', '..', 'conformance');
const VECTORS_PATH = path.join(
  CONFORMANCE_DIR,
  'fixtures',
  'deterministic-ids',
  'test-vectors.json',
);

interface FieldVector {
  label: string;
  proves: string[];
  resourceType: string;
  contentFields: Record<string, string | string[]>;
  canonicalIdentityString: string;
  expectedUri: string;
}

interface Vectors {
  version: string;
  primitiveVectors: Array<{ label: string; input: string; expectedUuid: string }>;
  contentHashedUriVectors: Array<{ label: string; identityString: string; expectedUri: string }>;
  multiValuedFieldVectors?: FieldVector[];
  keyOrderVectors?: FieldVector[];
}

const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf-8')) as Vectors;

/** Apply the canonical form of a set-valued field, as every real call site does. */
function flatten(fields: Record<string, string | string[]>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = Array.isArray(v) ? canonicalSetKey(v, ',') : v;
  }
  return out;
}

describe('conformance identity vectors', () => {
  // A `for` loop over an array that has quietly become empty generates zero
  // `it()` blocks and the suite reports green for having tested nothing.
  // readFileSync catches a MISSING file; it does not catch a hollowed-out one,
  // and the two look identical from here.
  it('every vector group is present and non-empty', () => {
    expect(vectors.primitiveVectors?.length, 'primitiveVectors').toBeGreaterThan(0);
    expect(vectors.contentHashedUriVectors?.length, 'contentHashedUriVectors').toBeGreaterThan(0);
    expect(vectors.multiValuedFieldVectors?.length, 'multiValuedFieldVectors').toBeGreaterThan(0);
    expect(vectors.keyOrderVectors?.length, 'keyOrderVectors').toBeGreaterThan(0);
  });

  // The astral vectors are the only ones that discriminate Unicode code-point
  // order from the UTF-16 code-unit order a JavaScript string comparison
  // performs. Every other vector passes under either rule, so a checkout that
  // had lost these two would leave this file fully green while proving nothing
  // about the property it was added to protect. Asserted by label.
  it('both astral-plane vectors are present, at the key sort and at the member sort', () => {
    expect((vectors.keyOrderVectors ?? []).map((v) => v.label)).toContain(
      'key-order-astral-vs-bmp',
    );
    expect((vectors.multiValuedFieldVectors ?? []).map((v) => v.label)).toContain(
      'condition-member-order-astral-vs-bmp',
    );
  });

  for (const v of vectors.primitiveVectors) {
    it(`primitiveVector: ${v.label}`, () => {
      expect(deterministicUuid(v.input)).toBe(v.expectedUuid);
    });
  }

  // Fed as a pre-flattened identity string, parsed back into fields. This
  // checks the digest and the identity-string layout; the two groups below
  // check the canonicalization that produces that string.
  for (const v of vectors.contentHashedUriVectors) {
    it(`contentHashedUriVector: ${v.label}`, () => {
      const [resourceType, fieldsPart] = v.identityString.split('::');
      const fields: Record<string, string> = {};
      for (const pair of fieldsPart.split('|')) {
        const eq = pair.indexOf('=');
        fields[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      expect(contentHashedUri(resourceType, fields)).toBe(v.expectedUri);
    });
  }

  for (const v of vectors.multiValuedFieldVectors ?? []) {
    it(`multiValuedFieldVector: ${v.label} [${v.proves.join(', ')}]`, () => {
      expect(contentHashedUri(v.resourceType, flatten(v.contentFields))).toBe(v.expectedUri);
    });
  }

  for (const v of vectors.keyOrderVectors ?? []) {
    it(`keyOrderVector: ${v.label} [${v.proves.join(', ')}]`, () => {
      expect(contentHashedUri(v.resourceType, flatten(v.contentFields))).toBe(v.expectedUri);
    });
  }
});
