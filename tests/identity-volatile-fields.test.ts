/**
 * A content hash is only as stable as its least stable input.
 *
 * This is the subtle way to reintroduce the bug the identity door exists to
 * kill. Replace `randomUUID()` with a hash of the resource and the obvious
 * defect is gone: import the same FILE twice and you get the same IRI, so every
 * test passes. But a resource re-fetched from an EHR is not the same bytes — the
 * server stamps a new `meta.lastUpdated` and bumps `meta.versionId` on every
 * touch, and regenerates `text` with its own formatting. Hash those and the IRI
 * moves on every sync, which is precisely the original defect, now wearing a
 * content hash and invisible to any test that reads from disk twice.
 *
 * So the exclusion list is pinned here, in both directions:
 *   - each excluded field must NOT move the identity, and
 *   - the fields around it must, so the exclusions are not quietly overbroad.
 *
 * The second direction matters more than it looks. `text` is a generated
 * Narrative on a Resource and a genuine clinical label on a CodeableConcept
 * ("Blood pressure"); `source` is a volatile provenance pointer under `meta`
 * and load-bearing content nearly everywhere else. A name-only exclusion would
 * delete real identity content and silently merge unrelated records — a worse
 * failure than the one being fixed, because a merge loses data where a split
 * only duplicates it.
 */

import { describe, it, expect } from 'vitest';
import {
  VOLATILE_FIELDS,
  contentFingerprint,
  stripVolatile,
  stableStringify,
  identitySeed,
  EMPTY_SEED,
  ANON_PREFIX,
} from '../src/lib/identity.js';

const BASE = {
  resourceType: 'Observation',
  status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] },
  effectiveDateTime: '2026-01-15T09:30:00Z',
  valueQuantity: { value: 72, unit: '/min' },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('the volatile-field exclusion list', () => {
  it('documents a reason for every entry', () => {
    expect(VOLATILE_FIELDS.length).toBeGreaterThan(0);
    for (const rule of VOLATILE_FIELDS) {
      expect(rule.why.length, `${rule.field} needs a stated reason`).toBeGreaterThan(60);
    }
  });

  it('is exactly the list this test was written against', () => {
    // Pinned so that adding or removing an exclusion is a deliberate act with a
    // test change attached, not a drive-by edit.
    expect(VOLATILE_FIELDS.map((r) => `${r.under ?? '*'}.${r.field}`).sort()).toEqual([
      '*.text',
      'meta.lastUpdated',
      'meta.source',
      'meta.versionId',
    ]);
  });

  it('meta.lastUpdated does not move the identity', () => {
    const a = clone(BASE) as any;
    const b = clone(BASE) as any;
    a.meta = { lastUpdated: '2026-01-15T09:31:00.000+00:00' };
    b.meta = { lastUpdated: '2026-08-01T22:14:03.512+00:00' };
    expect(contentFingerprint(a)).toBe(contentFingerprint(b));
    expect(contentFingerprint(a)).toBe(contentFingerprint(BASE));
  });

  it('meta.versionId does not move the identity', () => {
    const a = clone(BASE) as any;
    const b = clone(BASE) as any;
    a.meta = { versionId: '1' };
    b.meta = { versionId: '48' };
    expect(contentFingerprint(a)).toBe(contentFingerprint(b));
    expect(contentFingerprint(a)).toBe(contentFingerprint(BASE));
  });

  it('meta.source does not move the identity', () => {
    const a = clone(BASE) as any;
    const b = clone(BASE) as any;
    a.meta = { source: 'urn:oid:1.2.840.114350.1.13.1#v1' };
    b.meta = { source: 'urn:oid:1.2.840.114350.1.13.1#v9' };
    expect(contentFingerprint(a)).toBe(contentFingerprint(b));
    expect(contentFingerprint(a)).toBe(contentFingerprint(BASE));
  });

  it('a generated Narrative does not move the identity', () => {
    const a = clone(BASE) as any;
    const b = clone(BASE) as any;
    a.text = { status: 'generated', div: '<div>Heart rate 72 (rendered 2026-01-15)</div>' };
    b.text = { status: 'generated', div: '<div>Heart rate 72 (rendered 2026-08-01)</div>' };
    expect(contentFingerprint(a)).toBe(contentFingerprint(b));
    expect(contentFingerprint(a)).toBe(contentFingerprint(BASE));
  });

  it('volatile fields are stripped at ANY depth, not just at the root', () => {
    // A contained resource carries its own meta, and it is just as volatile.
    const a = clone(BASE) as any;
    const b = clone(BASE) as any;
    a.contained = [{ resourceType: 'Practitioner', meta: { lastUpdated: '2026-01-01T00:00:00Z' }, name: [{ family: 'Chen' }] }];
    b.contained = [{ resourceType: 'Practitioner', meta: { lastUpdated: '2026-08-01T00:00:00Z' }, name: [{ family: 'Chen' }] }];
    expect(contentFingerprint(a)).toBe(contentFingerprint(b));
  });

  it('meta.profile is NOT stripped — it is structural, and it routes genomics', () => {
    const plain = clone(BASE) as any;
    const genomic = clone(BASE) as any;
    genomic.meta = { profile: ['http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/variant'] };
    expect(contentFingerprint(plain)).not.toBe(contentFingerprint(genomic));
  });

  it('CodeableConcept.text IS identity — the text rule is shape-scoped, not name-scoped', () => {
    const a = clone(BASE) as any;
    const b = clone(BASE) as any;
    a.code.text = 'Heart rate, resting';
    b.code.text = 'Heart rate, post-exercise';
    expect(contentFingerprint(a)).not.toBe(contentFingerprint(b));
  });

  it('a `source` field outside meta IS identity', () => {
    const a = clone(BASE) as any;
    const b = clone(BASE) as any;
    a.device = { source: 'left-wrist' };
    b.device = { source: 'right-wrist' };
    expect(contentFingerprint(a)).not.toBe(contentFingerprint(b));
  });

  it('the non-volatile fields around the exclusions all still move it', () => {
    const variants: Array<(r: any) => void> = [
      (r) => { r.status = 'amended'; },
      (r) => { r.valueQuantity.value = 118; },
      (r) => { r.valueQuantity.unit = 'bpm'; },
      (r) => { r.effectiveDateTime = '2026-02-02T00:00:00Z'; },
      (r) => { r.code.coding[0].code = '8480-6'; },
      (r) => { r.code.coding[0].system = 'http://snomed.info/sct'; },
      (r) => { r.resourceType = 'DiagnosticReport'; },
    ];
    const base = contentFingerprint(BASE);
    for (const mutate of variants) {
      const r = clone(BASE) as any;
      mutate(r);
      expect(contentFingerprint(r), `${JSON.stringify(r)} should not equal the base`).not.toBe(base);
    }
  });
});

describe('the hash is stable against representation, not just content', () => {
  it('source key ORDER does not change the fingerprint', () => {
    const forward = clone(BASE) as any;
    const reversed: any = {};
    for (const k of Object.keys(forward).reverse()) reversed[k] = forward[k];
    expect(contentFingerprint(reversed)).toBe(contentFingerprint(forward));
  });

  it('nested key order does not change it either', () => {
    const a = { x: { p: 1, q: 2 }, y: [{ m: 3, n: 4 }] };
    const b = { y: [{ n: 4, m: 3 }], x: { q: 2, p: 1 } };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(contentFingerprint(a)).toBe(contentFingerprint(b));
  });

  it('ARRAY order DOES change it — FHIR array order is meaningful', () => {
    // name[0] is the primary name; reordering is a different resource.
    const a = { name: [{ family: 'Smith' }, { family: 'Jones' }] };
    const b = { name: [{ family: 'Jones' }, { family: 'Smith' }] };
    expect(contentFingerprint(a)).not.toBe(contentFingerprint(b));
  });
});

describe('the cascade has no third tier', () => {
  it('an explicit id wins and is returned verbatim', () => {
    expect(identitySeed({ explicitId: 'obs-1', content: BASE })).toEqual({ seed: 'obs-1', source: 'explicit' });
  });

  it('a blank or non-string id is not an id', () => {
    for (const notAnId of ['', '   ', null, undefined, 0, false, {}, []]) {
      expect(identitySeed({ explicitId: notAnId, content: BASE }).source).toBe('content');
    }
  });

  it('a content seed cannot be mistaken for a FHIR id', () => {
    const { seed } = identitySeed({ content: BASE });
    expect(seed.startsWith(ANON_PREFIX)).toBe(true);
    // FHIR caps Resource.id at 64 characters; `anon-` + 64 hex is 69.
    expect(seed.length).toBe(ANON_PREFIX.length + 64);
    expect(seed.length).toBeGreaterThan(64);
  });

  it('a resource with nothing but volatile fields lands on the sentinel, not on randomness', () => {
    const nothing = { meta: { lastUpdated: '2026-01-01T00:00:00Z', versionId: '3' } };
    const a = identitySeed({ content: nothing });
    const b = identitySeed({ content: { meta: { lastUpdated: '2027-09-09T00:00:00Z', versionId: '9' } } });
    expect(a).toEqual({ seed: EMPTY_SEED, source: 'empty' });
    expect(b).toEqual(a);
  });

  it('stripping prunes containers that become empty', () => {
    expect(stripVolatile({ meta: { lastUpdated: 'x' } })).toBeUndefined();
    expect(stripVolatile({ a: 1, meta: { lastUpdated: 'x' } })).toEqual({ a: 1 });
    expect(stripVolatile({ list: [{ meta: { versionId: '1' } }] })).toBeUndefined();
  });

  it('no input produces a different result on a second call', () => {
    const inputs: unknown[] = [BASE, {}, null, undefined, [], 'x', 42, { meta: { versionId: '1' } }];
    for (const input of inputs) {
      expect(identitySeed({ content: input })).toEqual(identitySeed({ content: input }));
    }
  });
});
