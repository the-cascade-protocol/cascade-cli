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

  it('is exactly the list this test was written against, kinds included', () => {
    // Pinned so that adding or removing an exclusion — or, just as importantly,
    // RECLASSIFYING one — is a deliberate act with a test change attached.
    // The kind is what decides whether a field can still rescue an otherwise
    // empty record at tier 3, so a silent volatile/derivative swap would be a
    // data-loss change that looked like a rename.
    expect(VOLATILE_FIELDS.map((r) => `${r.kind}:${r.under ?? '*'}.${r.field}`).sort()).toEqual([
      'derivative:*.text',
      'scaffold:*.resourceType',
      'volatile:meta.lastUpdated',
      'volatile:meta.source',
      'volatile:meta.versionId',
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

  it('resourceType is scaffold: it does not change the FINGERPRINT...', () => {
    // ...because every call site already splices it into the key template, so
    // hashing it too is redundant. See the IRI-level test below for why that
    // does not let two types collide.
    const a = clone(BASE) as any;
    a.resourceType = 'DiagnosticReport';
    expect(contentFingerprint(a)).toBe(contentFingerprint(BASE));
  });

  it('...but it must not count as CONTENT, or salvage can never run', () => {
    // The bug this encodes: while resourceType counted as content, a
    // narrative-only resource stripped down to {"resourceType":"Condition"} —
    // identical for every Condition in existence — so tier 2 "succeeded" with a
    // constant and two different records merged.
    expect(stripVolatile({ resourceType: 'Condition' })).toBeUndefined();
    expect(identitySeed({ content: { resourceType: 'Condition' } }).source).toBe('empty');
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

  it('TIER 3 SALVAGE: a derivative field rescues an otherwise-empty record', () => {
    const a = identitySeed({ content: { resourceType: 'Condition', text: { div: '<div>Type 2 diabetes mellitus</div>' } } });
    const b = identitySeed({ content: { resourceType: 'Condition', text: { div: '<div>Metastatic breast cancer</div>' } } });
    expect(a.source).toBe('salvage');
    expect(b.source).toBe('salvage');
    expect(a.seed).not.toBe(b.seed);
    expect(a.seed).not.toBe(EMPTY_SEED);
  });

  it('salvage is stable for the same content', () => {
    const mk = () => ({ resourceType: 'Condition', text: { div: '<div>Type 2 diabetes mellitus</div>' } });
    expect(identitySeed({ content: mk() })).toEqual(identitySeed({ content: mk() }));
  });

  it('a VOLATILE field never rescues — using it IS the original bug', () => {
    // If meta.lastUpdated could salvage, an empty resource would mint a new IRI
    // on every EHR sync. Volatile fields are excluded at every tier for exactly
    // this reason, which is why they are a separate kind from derivative ones.
    const a = identitySeed({ content: { resourceType: 'X', meta: { lastUpdated: '2026-01-01T00:00:00Z' } } });
    const b = identitySeed({ content: { resourceType: 'X', meta: { lastUpdated: '2026-08-02T00:00:00Z' } } });
    expect(a.source).toBe('empty');
    expect(a.seed).toBe(b.seed);
  });

  it('a tier-3 seed can never equal a tier-2 seed (domain separation)', () => {
    const salvage = identitySeed({ content: { resourceType: 'C', text: { div: 'x' } } });
    const content = identitySeed({ content: { resourceType: 'C', text: { div: 'x' }, code: 'k' } });
    expect(salvage.source).toBe('salvage');
    expect(content.source).toBe('content');
    expect(salvage.seed).not.toBe(content.seed);
  });

  it('tier 4 emits a warning; tiers 1-3 do not', () => {
    const w: string[] = [];
    identitySeed({ explicitId: 'abc', content: {}, warnings: w, label: 'T1' });
    identitySeed({ content: { code: 'k' }, warnings: w, label: 'T2' });
    identitySeed({ content: { text: { div: 'x' } }, warnings: w, label: 'T3' });
    expect(w).toEqual([]);

    identitySeed({ content: { resourceType: 'Condition' }, warnings: w, label: 'Condition (no id)' });
    expect(w.length).toBe(1);
    expect(w[0]).toContain('Condition (no id)');
    expect(w[0]).toContain('no identity-bearing content');
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
