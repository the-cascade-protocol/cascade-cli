/**
 * Unit acceptance for the bucket write chokepoint (`src/lib/bucket-write.ts`).
 *
 * The defect this replaces: a record-data writer stripped every leading
 * `@prefix` line, re-emitted a header of its OWN namespaces, and kept a body
 * full of CURIEs whose prefixes it had just deleted. `medications.ttl` written
 * by an import (which declares `rxnorm:`) stopped parsing the moment a
 * hand-entered record landed in it, and one unreadable bucket fails the whole
 * pod read.
 *
 * The guarantee under test is structural, not "we remembered the five missing
 * prefixes": the writer owns the whole document, so a CURIE whose prefix is
 * undeclared is unrepresentable. These tests pin the properties that guarantee
 * rests on — prefix harvesting, relative-IRI stability, blank-node label
 * bounding, and the refusal to write over a file that does not parse.
 *
 * All fixtures are synthetic and PHI-free.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Parser, DataFactory } from 'n3';
import type { Quad } from 'n3';
import {
  mergeIntoBucket,
  BucketParseError,
  KNOWN_PREFIXES,
  relBase,
  derelativizeQuads,
  normalizeBlankNodes,
  parseBucketTurtle,
} from '../src/lib/bucket-write.js';
import { generateDek, readResource } from '../src/lib/pod-encryption.js';
import { TURTLE_PREFIXES } from '../src/lib/fhir-converter/types.js';

const { namedNode, literal, blankNode, quad: makeQuad } = DataFactory;

const NS = {
  clinical: 'https://ns.cascadeprotocol.org/clinical/v1#',
  cascade: 'https://ns.cascadeprotocol.org/core/v1#',
  prov: 'http://www.w3.org/ns/prov#',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-bucketwrite-'));
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function file(name = 'medications.ttl'): string {
  return path.join(tmp, name);
}

function seed(content: string, name = 'medications.ttl'): string {
  const p = file(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

/** One self-reported Medication, exactly as `pod add-record` builds it. */
function recordQuads(uri = 'urn:uuid:NEW', drug = 'Vitamin D'): Quad[] {
  const s = namedNode(uri);
  return [
    makeQuad(s, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'Medication')),
    makeQuad(s, namedNode(NS.clinical + 'drugName'), literal(drug)),
    makeQuad(s, namedNode(NS.cascade + 'dataProvenance'), namedNode(NS.cascade + 'SelfReported')),
    // Root-relative on purpose: this is the pod's patient WebID.
    makeQuad(s, namedNode(NS.prov + 'wasAttributedTo'), namedNode('/profile/card.ttl#me')),
  ];
}

/** Strict re-parse. Throws exactly the way the whole-pod read would. */
function strictParse(turtle: string): Quad[] {
  return new Parser({ format: 'Turtle' }).parse(turtle);
}

function quadKey(q: Quad): string {
  const o = q.object.termType === 'Literal'
    ? `L:${q.object.value}|${q.object.datatype?.value ?? ''}|${q.object.language ?? ''}`
    : `${q.object.termType}:${q.object.value}`;
  return `${q.subject.termType}:${q.subject.value}|${q.predicate.value}|${o}`;
}

/** Quad-set comparison that ignores blank-node LABELS (not RDF-significant). */
function sameGraph(a: Quad[], b: Quad[]): boolean {
  const norm = (qs: Quad[]) =>
    new Set(qs.map((q) => quadKey(q).replace(/BlankNode:[^|]+/g, 'BlankNode:B')));
  const sa = norm(a);
  const sb = norm(b);
  return sa.size === sb.size && [...sa].every((k) => sb.has(k));
}

// ---------------------------------------------------------------------------
// The regression: an importer's prefixes must survive a hand-entered record
// ---------------------------------------------------------------------------

/**
 * A bucket exactly as `pod import` leaves it: CURIEs from four registries the
 * record writers have never heard of.
 */
const IMPORTED_BUCKET = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#>.
@prefix health: <https://ns.cascadeprotocol.org/health/v1#>.
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#>.
@prefix rxnorm: <http://www.nlm.nih.gov/research/umls/rxnorm/>.
@prefix sct: <http://snomed.info/sct/>.
@prefix loinc: <http://loinc.org/rdf#>.
@prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

<urn:uuid:OLD> a clinical:Medication;
    clinical:rxNormCode rxnorm:860975;
    clinical:code sct:73211009;
    clinical:labCode loinc:2345-7;
    vcard:hasNote "imported";
    health:startDate "2024-01-15T00:00:00Z"^^xsd:dateTime.
`;

describe('mergeIntoBucket: the existing document keeps the prefixes it declared', () => {
  it('leaves an imported bucket parseable after a record is merged in', async () => {
    const p = seed(IMPORTED_BUCKET);
    await mergeIntoBucket(p, recordQuads(), undefined);

    const out = fs.readFileSync(p, 'utf-8');
    // The whole point: a STRICT parse, which is what the whole-pod read does.
    expect(() => strictParse(out)).not.toThrow();
    expect(strictParse(out)).toHaveLength(10);
  });

  it('keeps every registry prefix the file declared and the CURIEs that use them', async () => {
    const p = seed(IMPORTED_BUCKET);
    await mergeIntoBucket(p, recordQuads(), undefined);
    const out = fs.readFileSync(p, 'utf-8');

    for (const prefix of ['rxnorm', 'sct', 'loinc', 'vcard']) {
      expect(out, `@prefix ${prefix}: was dropped`).toContain(`@prefix ${prefix}:`);
    }
    expect(out).toContain('rxnorm:860975');
    expect(out).toContain('sct:73211009');
    expect(out).toContain('loinc:2345-7');
  });

  it('preserves a declared prefix even when nothing in the file uses it', async () => {
    // A writer that emitted only the prefixes IT could see would silently drop
    // this, which is invisible until the next record uses the namespace.
    const p = seed(
      `@prefix mine: <http://alice.example/vocab#>.\n@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#>.\n<urn:uuid:OLD> a clinical:Medication.\n`,
    );
    await mergeIntoBucket(p, recordQuads(), undefined);
    expect(fs.readFileSync(p, 'utf-8')).toContain('@prefix mine: <http://alice.example/vocab#>');
  });

  it('keeps a USED namespace KNOWN_PREFIXES has never heard of written as a CURIE', async () => {
    // This is what harvesting actually buys. The four registries the shipped
    // defect deleted are now in KNOWN_PREFIXES, so they would survive either
    // way; a namespace outside it (NDC, ATC, ICD-10, a genomics advisory
    // vocabulary, a user's own) only stays compact because the document's own
    // declarations are read back and re-emitted.
    const p = seed(
      `@prefix ndc: <http://hl7.org/fhir/sid/ndc/>.\n` +
      `@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#>.\n` +
      `<urn:uuid:OLD> a clinical:Medication; clinical:ndcCode ndc:0093-1023.\n`,
    );
    await mergeIntoBucket(p, recordQuads(), undefined);
    const out = fs.readFileSync(p, 'utf-8');
    expect(out).toContain('@prefix ndc: <http://hl7.org/fhir/sid/ndc/>');
    expect(out).toContain('ndc:0093-1023');
  });

  it('lets the file win when it binds a Cascade prefix name to another namespace', async () => {
    // The file's `clinical:` is NOT the Cascade clinical namespace. The merged
    // record must not be silently re-bound to the file's meaning, and the
    // file's own records must not be re-bound to Cascade's.
    const hostile = `@prefix clinical: <http://example.org/private-clinical#>.
<urn:uuid:OLD> a clinical:Medication; clinical:drugName "Aspirin".
`;
    const p = seed(hostile);
    await mergeIntoBucket(p, recordQuads(), undefined);

    const out = fs.readFileSync(p, 'utf-8');
    const quads = strictParse(out);
    const typeOf = (s: string) =>
      quads.find((q) => q.subject.value === s && q.predicate.value === NS.rdf + 'type')?.object.value;
    expect(typeOf('urn:uuid:OLD')).toBe('http://example.org/private-clinical#Medication');
    expect(typeOf('urn:uuid:NEW')).toBe(NS.clinical + 'Medication');

    // PRECEDENCE, asserted on the TEXT. `{...KNOWN_PREFIXES, ...filePrefixes}`
    // can be written the other way round and the assertions above cannot tell:
    // both spellings denote the same graph, so a strict parse is identical
    // either way. Only the header says which binding won, and the module's
    // contract is that the file's own declarations do — that is what keeps a
    // bucket recognisable as the document its writer left behind.
    expect(out).toContain('@prefix clinical: <http://example.org/private-clinical#>');
    expect(out).not.toContain(`@prefix clinical: <${NS.clinical}>`);
  });

  it('writes a full <IRI> rather than an undeclared CURIE for an unknown namespace', async () => {
    // The structural guarantee. There is no way to emit `weird:Thing` without a
    // declaration, because the writer decides the abbreviation, not the caller.
    const p = file();
    const s = namedNode('urn:uuid:X');
    await mergeIntoBucket(p, [makeQuad(s, namedNode('http://weird.example/v9#p'), literal('v'))], undefined);
    const out = fs.readFileSync(p, 'utf-8');
    expect(out).toContain('<http://weird.example/v9#p>');
    expect(() => strictParse(out)).not.toThrow();
  });

  it('APPENDS: what the file already held stays put, byte for byte, at the front', async () => {
    // The default combine is `[...existing, ...incoming]`. Prepending, or
    // sorting, keeps every graph-level assertion in this file green and keeps
    // `pod-import-reimport-idempotence` green too — that suite compares import
    // N against import N+1 under the SAME build, so any consistent order is
    // idempotent by construction. Nothing else notices that every record in
    // every bucket moved. A whole-file diff on the next write is not a
    // cosmetic difference for a document users read and version.
    const p = seed(IMPORTED_BUCKET);
    await mergeIntoBucket(p, [], undefined);
    const before = fs.readFileSync(p, 'utf-8');

    await mergeIntoBucket(p, recordQuads(), undefined);
    const after = fs.readFileSync(p, 'utf-8');

    expect(after.startsWith(before), 'the existing document was rewritten, not appended to').toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.slice(before.length)).toContain('Vitamin D');
  });

  it('is stable: repeated merges neither duplicate nor drop a declaration', async () => {
    const p = seed(IMPORTED_BUCKET);
    for (let i = 0; i < 5; i++) {
      await mergeIntoBucket(p, recordQuads(`urn:uuid:N${i}`), undefined);
    }
    const out = fs.readFileSync(p, 'utf-8');
    for (const prefix of ['rxnorm', 'sct', 'loinc', 'vcard', 'clinical', 'cascade']) {
      const count = (out.match(new RegExp(`@prefix ${prefix}:`, 'g')) ?? []).length;
      expect(count, `@prefix ${prefix}: declared ${count} times`).toBe(1);
    }
    expect(strictParse(out)).toHaveLength(6 + 5 * 4);
  });
});

// ---------------------------------------------------------------------------
// Refusal: an unreadable bucket is never overwritten
// ---------------------------------------------------------------------------

describe('mergeIntoBucket: an existing file that does not parse is a refusal', () => {
  /** The exact field state: a body whose CURIE prefixes were deleted. */
  const CORRUPT = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#>.
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#>.

<urn:uuid:OLD> a clinical:Medication;
    clinical:rxNormCode rxnorm:860975.
`;

  it('throws BucketParseError and leaves the file byte-identical', async () => {
    const p = seed(CORRUPT);
    const before = fs.readFileSync(p);

    await expect(mergeIntoBucket(p, recordQuads(), undefined)).rejects.toBeInstanceOf(BucketParseError);
    expect(fs.readFileSync(p).equals(before)).toBe(true);
  });

  it('names the file and the underlying reason', async () => {
    const p = seed(CORRUPT);
    const err = await mergeIntoBucket(p, recordQuads(), undefined).catch((e) => e as BucketParseError);
    expect(err).toBeInstanceOf(BucketParseError);
    expect(err.file).toBe(p);
    expect(err.message).toContain(p);
    expect(err.message).toMatch(/rxnorm/);
    expect(err.message).toMatch(/[Nn]othing was written/);
  });

  it('refuses on outright garbage too', async () => {
    const p = seed('<<< this is not turtle &&& ');
    const before = fs.readFileSync(p);
    await expect(mergeIntoBucket(p, recordQuads(), undefined)).rejects.toBeInstanceOf(BucketParseError);
    expect(fs.readFileSync(p).equals(before)).toBe(true);
  });

  it('does not create the file when the merge is refused', async () => {
    // Belt and braces: the refusal happens before any mkdir/write.
    const p = seed(CORRUPT, 'nested/deep/meds.ttl');
    await expect(mergeIntoBucket(p, recordQuads(), undefined)).rejects.toThrow();
    expect(fs.readdirSync(path.dirname(p))).toEqual(['meds.ttl']);
  });

  it('writes nothing when the validate hook rejects the merged document', async () => {
    const p = seed(IMPORTED_BUCKET);
    const before = fs.readFileSync(p);
    await expect(
      mergeIntoBucket(p, recordQuads(), undefined, {
        validate: () => { throw new Error('SHACL says no'); },
      }),
    ).rejects.toThrow(/SHACL says no/);
    expect(fs.readFileSync(p).equals(before)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Relative IRIs
// ---------------------------------------------------------------------------

describe('mergeIntoBucket: relative IRIs come out exactly as they went in', () => {
  const FORMS: Array<[string, string]> = [
    ['root-relative', '</profile/card.ttl#me>'],
    ['doc-relative', '<profile/card.ttl>'],
    ['empty', '<>'],
    ['fragment-only', '<#me>'],
  ];

  for (const [label, iri] of FORMS) {
    it(`preserves a ${label} IRI across six successive writes`, async () => {
      const p = seed(`@prefix prov: <http://www.w3.org/ns/prov#>.\n<urn:uuid:OLD> prov:wasAttributedTo ${iri}.\n`);
      for (let i = 0; i < 6; i++) {
        await mergeIntoBucket(p, recordQuads(`urn:uuid:N${i}`), undefined);
        const out = fs.readFileSync(p, 'utf-8');
        // Assert on the IRI TEXT. `baseIRI: ''` still produced a parseable
        // file; it just said "undefined/profile/card.ttl#me" instead.
        expect(out, `write ${i + 1}`).toContain(`prov:wasAttributedTo ${iri}`);
        expect(out, `write ${i + 1}`).not.toContain('undefined/');
      }
    });
  }

  it('never lets the sentinel base reach disk', async () => {
    const p = seed(`<urn:uuid:OLD> <urn:p> </profile/card.ttl#me>.\n`);
    for (let i = 0; i < 3; i++) await mergeIntoBucket(p, recordQuads(`urn:uuid:N${i}`), undefined);
    expect(fs.readFileSync(p, 'utf-8')).not.toContain(relBase());
  });

  it('strips the sentinel from quads a CALLER supplies, not only from what it parsed', async () => {
    // Defence in depth, and the reason the strip runs on the MERGED list rather
    // than only inside the parse: `pod erase` and `pod import` hand over quads
    // that travelled through their own parsers. If one of them ever stops
    // derelativizing, the sentinel must still not reach disk.
    const p = file();
    await mergeIntoBucket(p, [
      makeQuad(
        namedNode(relBase() + '/records/1'),
        namedNode('urn:p'),
        namedNode(relBase() + '/profile/card.ttl#me'),
      ),
    ], undefined);
    const out = fs.readFileSync(p, 'utf-8');
    expect(out).not.toContain(relBase());
    expect(out).toContain('</profile/card.ttl#me>');
    expect(out).toContain('</records/1>');
  });

  it('leaves absolute IRIs untouched', async () => {
    const p = seed(`<urn:uuid:OLD> <urn:p> <https://example.org/a?q=1&r=2#f>.\n`);
    await mergeIntoBucket(p, recordQuads(), undefined);
    expect(fs.readFileSync(p, 'utf-8')).toContain('<https://example.org/a?q=1&r=2#f>');
  });

  it('resolves a document @base and then states the result absolutely', async () => {
    // Documented consequence, pinned so it cannot change silently: `@base` is a
    // parse-time directive the writer does not re-emit, so the IRIs it resolved
    // are written out in full. Semantics are preserved; the directive is not.
    const p = seed(`@base <https://pod.example/alice/>.\n<records/1> <urn:p> <urn:o>.\n`);
    await mergeIntoBucket(p, recordQuads(), undefined);
    const quads = strictParse(fs.readFileSync(p, 'utf-8'));
    expect(quads.some((q) => q.subject.value === 'https://pod.example/alice/records/1')).toBe(true);
  });

  it('derelativizeQuads is a no-op on quads that carry no sentinel', () => {
    const qs = recordQuads();
    expect(derelativizeQuads(qs)).toEqual(qs);
  });
});

// ---------------------------------------------------------------------------
// Blank nodes
// ---------------------------------------------------------------------------

describe('mergeIntoBucket: blank-node labels stay bounded', () => {
  it('does not grow labels across ten successive writes', async () => {
    // N3's parser prefixes each label it reads with a fresh counter, so without
    // normalization `_:b1` becomes `_:b2_b1`, `_:b3_b2_b1`, ... forever.
    const p = seed(`<urn:uuid:OLD> <urn:p> [ <urn:q> "deep" ].\n`);
    for (let i = 0; i < 10; i++) await mergeIntoBucket(p, recordQuads(`urn:uuid:N${i}`), undefined);

    const out = fs.readFileSync(p, 'utf-8');
    const labels = [...out.matchAll(/_:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    for (const l of labels) {
      expect(l.length, `blank-node label "${l}" is growing`).toBeLessThanOrEqual(4);
    }
    // The seed is 2 triples (the record and the blank node's own statement).
    expect(strictParse(out).length).toBe(2 + 10 * 4);
  });

  it('preserves blank-node structure, including cycles and shared nodes', async () => {
    const p = seed(`_:x <urn:p> _:y. _:y <urn:p> _:x. <urn:uuid:OLD> <urn:r> _:x.\n`);
    const before = strictParse(fs.readFileSync(p, 'utf-8'));
    await mergeIntoBucket(p, [], undefined);
    const after = strictParse(fs.readFileSync(p, 'utf-8'));
    expect(sameGraph(before, after)).toBe(true);
  });

  it('normalizeBlankNodes renumbers deterministically and loses nothing', () => {
    const a = blankNode('long_label_from_a_previous_parse');
    const b = blankNode('another_long_one');
    const qs = [
      makeQuad(a, namedNode('urn:p'), b),
      makeQuad(b, namedNode('urn:p'), a),
    ];
    const out = normalizeBlankNodes(qs);
    expect(out.map((q) => q.subject.value)).toEqual(['b0', 'b1']);
    expect(out.map((q) => q.object.value)).toEqual(['b1', 'b0']);
    expect(normalizeBlankNodes(qs)).toEqual(out);
  });
});

// ---------------------------------------------------------------------------
// Lexical fidelity of everything a bucket could hold
// ---------------------------------------------------------------------------

describe('mergeIntoBucket: round-trip fidelity of Turtle a bucket could hold', () => {
  const CASES: Record<string, string> = {
    'xsd:dateTime canonical': `<urn:uuid:a> <urn:p> "2026-08-07T16:27:35.613Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>.`,
    'xsd:dateTime with offset': `<urn:uuid:a> <urn:p> "2026-08-07T09:27:35.613-07:00"^^<http://www.w3.org/2001/XMLSchema#dateTime>.`,
    'xsd:date': `<urn:uuid:a> <urn:p> "2026-08-07"^^<http://www.w3.org/2001/XMLSchema#date>.`,
    'integer shorthand': `<urn:uuid:a> <urn:p> 42.`,
    'decimal shorthand': `<urn:uuid:a> <urn:p> 3.140.`,
    'double shorthand': `<urn:uuid:a> <urn:p> 1.0e6.`,
    'xsd:integer leading zeros': `<urn:uuid:a> <urn:p> "007"^^<http://www.w3.org/2001/XMLSchema#integer>.`,
    'boolean shorthand': `<urn:uuid:a> <urn:p> true.`,
    'language tag': `<urn:uuid:a> <urn:p> "hola"@es.`,
    'language tag with region': `<urn:uuid:a> <urn:p> "colour"@en-GB.`,
    'plain string': `<urn:uuid:a> <urn:p> "plain".`,
    'explicit xsd:string': `<urn:uuid:a> <urn:p> "plain"^^<http://www.w3.org/2001/XMLSchema#string>.`,
    'literal with newline': `<urn:uuid:a> <urn:p> "line1\\nline2".`,
    'literal with quote and backslash': `<urn:uuid:a> <urn:p> "he said \\"hi\\" \\\\ done".`,
    'literal with tab and CR': `<urn:uuid:a> <urn:p> "a\\tb\\rc".`,
    'triple-quoted long string': `<urn:uuid:a> <urn:p> """multi\nline\nnote""".`,
    'unicode literal': `<urn:uuid:a> <urn:p> "café 😀 日本語".`,
    'escaped unicode literal': `<urn:uuid:a> <urn:p> "\\u0041\\u00E9".`,
    'empty literal': `<urn:uuid:a> <urn:p> "".`,
    'IRI with percent-encoding': `<urn:uuid:a> <urn:p> <http://ex.org/a%20b%2Fc>.`,
    'IRI with query and fragment': `<urn:uuid:a> <urn:p> <http://ex.org/p?q=1&r=2#frag>.`,
    'RDF collection': `<urn:uuid:a> <urn:p> ( "1" "2" "3" ).`,
    'nested blank nodes': `<urn:uuid:a> <urn:p> [ <urn:q> [ <urn:r> "deep" ] ].`,
    'duplicate triple': `<urn:uuid:a> <urn:p> "v". <urn:uuid:a> <urn:p> "v".`,
    'CURIE with escaped dash': `@prefix p: <http://ex.org/>.\n<urn:uuid:a> p:has\\-dash "v".`,
    'a vs rdf:type': `<urn:uuid:a> a <http://ex.org/T>.`,
    'multiple subjects': `<urn:uuid:a> <urn:p> "1". <urn:uuid:b> <urn:p> "2".`,
  };

  for (const [name, ttl] of Object.entries(CASES)) {
    it(`preserves: ${name}`, async () => {
      const p = seed(ttl + '\n');
      const before = strictParse(fs.readFileSync(p, 'utf-8'));
      await mergeIntoBucket(p, [], undefined);
      const after = strictParse(fs.readFileSync(p, 'utf-8'));
      expect(after.length).toBeGreaterThan(0);
      expect(sameGraph(before, after), `${name}: graph changed`).toBe(true);
    });
  }

  it('is a fixed point: a second merge of nothing changes nothing', async () => {
    const p = seed(IMPORTED_BUCKET);
    await mergeIntoBucket(p, [], undefined);
    const once = fs.readFileSync(p, 'utf-8');
    await mergeIntoBucket(p, [], undefined);
    expect(fs.readFileSync(p, 'utf-8')).toBe(once);
  });

  it('DOES lose comments — which is why scaffolding files must not route here', async () => {
    // Pinned as a known, deliberate loss. `profile/extended.ttl` anchors its PHI
    // population on a literal comment line, so routing it through this chokepoint
    // would permanently break that. The boundary is not cosmetic.
    const p = seed(`# a load-bearing comment\n<urn:uuid:a> <urn:p> "v".\n`);
    await mergeIntoBucket(p, [], undefined);
    expect(fs.readFileSync(p, 'utf-8')).not.toContain('load-bearing comment');
  });
});

// ---------------------------------------------------------------------------
// Degenerate documents
// ---------------------------------------------------------------------------

describe('mergeIntoBucket: degenerate documents', () => {
  it('creates the file, and its parent directories, when it does not exist', async () => {
    const p = path.join(tmp, 'clinical', 'medications.ttl');
    const res = await mergeIntoBucket(p, recordQuads(), undefined);
    expect(res.existedBefore).toBe(false);
    expect(res.triplesBefore).toBe(0);
    expect(res.triplesAfter).toBe(4);
    expect(() => strictParse(fs.readFileSync(p, 'utf-8'))).not.toThrow();
  });

  it('handles an empty file', async () => {
    const p = seed('');
    await mergeIntoBucket(p, recordQuads(), undefined);
    expect(strictParse(fs.readFileSync(p, 'utf-8'))).toHaveLength(4);
  });

  it('handles a whitespace-only file', async () => {
    const p = seed('   \n\n\t \n');
    await mergeIntoBucket(p, recordQuads(), undefined);
    expect(strictParse(fs.readFileSync(p, 'utf-8'))).toHaveLength(4);
  });

  it('handles a header-only file with no statements', async () => {
    const p = seed(`@prefix rxnorm: <http://www.nlm.nih.gov/research/umls/rxnorm/>.\n`);
    await mergeIntoBucket(p, recordQuads(), undefined);
    const out = fs.readFileSync(p, 'utf-8');
    expect(strictParse(out)).toHaveLength(4);
    expect(out).toContain('@prefix rxnorm:');
  });

  it('handles a header that appears AFTER statements (legal Turtle)', async () => {
    const p = seed(
      `<urn:uuid:A> <urn:p> <urn:o>.\n@prefix rxnorm: <http://www.nlm.nih.gov/research/umls/rxnorm/>.\n<urn:uuid:B> <urn:p> rxnorm:1.\n`,
    );
    await mergeIntoBucket(p, recordQuads(), undefined);
    const out = fs.readFileSync(p, 'utf-8');
    expect(() => strictParse(out)).not.toThrow();
    expect(out).toContain('@prefix rxnorm:');
    expect(out).toContain('rxnorm:1');
  });

  it('handles SPARQL-style PREFIX declarations', async () => {
    const p = seed(
      `PREFIX rxnorm: <http://www.nlm.nih.gov/research/umls/rxnorm/>\n<urn:uuid:OLD> <urn:p> rxnorm:1.\n`,
    );
    await mergeIntoBucket(p, recordQuads(), undefined);
    const out = fs.readFileSync(p, 'utf-8');
    expect(() => strictParse(out)).not.toThrow();
    expect(out).toContain('rxnorm:1');
  });

  it('writes an empty document when every quad is combined away', async () => {
    // `pod erase` of the last record in a bucket.
    const p = seed(IMPORTED_BUCKET);
    await mergeIntoBucket(p, [], undefined, { combine: () => [] });
    const out = fs.readFileSync(p, 'utf-8');
    expect(strictParse(out)).toHaveLength(0);
    expect(() => strictParse(out)).not.toThrow();
  });

  it('parseBucketTurtle reports the prefixes a document declared', async () => {
    const { quads, prefixes } = await parseBucketTurtle(IMPORTED_BUCKET);
    expect(quads).toHaveLength(6);
    expect(prefixes.rxnorm).toBe('http://www.nlm.nih.gov/research/umls/rxnorm/');
    expect(prefixes.loinc).toBe('http://loinc.org/rdf#');
  });
});

// ---------------------------------------------------------------------------
// dryRun and encryption
// ---------------------------------------------------------------------------

describe('mergeIntoBucket: dryRun and encrypted pods', () => {
  it('computes the document but writes nothing under dryRun', async () => {
    const p = seed(IMPORTED_BUCKET);
    const before = fs.readFileSync(p);
    const res = await mergeIntoBucket(p, recordQuads(), undefined, { dryRun: true });
    expect(res.written).toBe(false);
    expect(res.triplesAfter).toBe(10);
    expect(res.turtle).toContain('@prefix rxnorm:');
    expect(fs.readFileSync(p).equals(before)).toBe(true);
  });

  it('still refuses an unreadable file under dryRun', async () => {
    const p = seed(`@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#>.\n<urn:uuid:O> <urn:p> rxnorm:1.\n`);
    await expect(mergeIntoBucket(p, recordQuads(), undefined, { dryRun: true }))
      .rejects.toBeInstanceOf(BucketParseError);
  });

  it('is transparent over an encrypted resource', async () => {
    const dek = generateDek();
    const p = file();
    await mergeIntoBucket(p, recordQuads('urn:uuid:A'), dek);
    // Ciphertext on disk: the plaintext must not be readable.
    expect(fs.readFileSync(p).toString('utf-8')).not.toContain('Vitamin D');
    // ...and a second merge reads it back, keeping both records.
    await mergeIntoBucket(p, recordQuads('urn:uuid:B', 'Magnesium'), dek);
    const plain = readResource(p, dek);
    expect(plain).toContain('Vitamin D');
    expect(plain).toContain('Magnesium');
    expect(strictParse(plain)).toHaveLength(8);
    expect(plain).toContain('prov:wasAttributedTo </profile/card.ttl#me>');
  });
});

// ---------------------------------------------------------------------------
// The prefix registry
// ---------------------------------------------------------------------------

describe('KNOWN_PREFIXES', () => {
  it('covers every namespace the record and overlay writers emit', () => {
    for (const p of ['cascade', 'health', 'clinical', 'coverage', 'checkup', 'pots', 'workbench', 'fhir', 'prov', 'dct', 'xsd']) {
      expect(KNOWN_PREFIXES[p], `${p} missing`).toBeTruthy();
    }
  });

  it('covers the registries the importer writes, so an import round-trip stays compact', () => {
    for (const p of ['sct', 'loinc', 'rxnorm', 'vcard']) {
      expect(KNOWN_PREFIXES[p], `${p} missing`).toBeTruthy();
    }
  });

  it('binds cascade: and core: to the same namespace as the rest of the CLI', () => {
    expect(KNOWN_PREFIXES.cascade).toBe('https://ns.cascadeprotocol.org/core/v1#');
  });

  it('opens with TURTLE_PREFIXES, in TURTLE_PREFIXES\' order', () => {
    // The doc comment states this contract, and reversing all fifteen entries
    // leaves the whole suite green, so nothing enforced it.
    //
    // What the order actually buys, stated precisely so it is not over-claimed:
    // an N3 Writer emits declarations in insertion order, so matching the
    // importer's order keeps a bucket an OLDER CLI wrote from having its whole
    // header block reshuffled the first time this module rewrites it. It is
    // diff-churn control. It is NOT what keeps the re-import idempotence suite
    // byte-stable — that compares two runs of the same build, which agree on
    // any order.
    expect(Object.keys(KNOWN_PREFIXES).slice(0, Object.keys(TURTLE_PREFIXES).length))
      .toEqual(Object.keys(TURTLE_PREFIXES));
    for (const [name, ns] of Object.entries(TURTLE_PREFIXES)) {
      expect(KNOWN_PREFIXES[name], `${name} bound differently from the importer`).toBe(ns);
    }
  });
});

// ---------------------------------------------------------------------------
// A read failure is not a parse failure
// ---------------------------------------------------------------------------

describe('mergeIntoBucket: a read failure is never reported as a parse failure', () => {
  it('propagates a wrong-DEK failure untouched instead of blaming the file', async () => {
    // Moving `readResource` inside the try/catch keeps the whole suite green
    // while turning "your passphrase is wrong" into "this file is not valid
    // Turtle: ... Nothing was written." That tells a user to repair, or delete,
    // a bucket that is perfectly intact — the worst possible advice, given the
    // file is ciphertext they cannot inspect to check.
    const p = file();
    await mergeIntoBucket(p, recordQuads('urn:uuid:A'), generateDek());

    const err = await mergeIntoBucket(p, recordQuads('urn:uuid:B'), generateDek())
      .then(() => undefined, (e: unknown) => e);
    expect(err, 'a merge under the wrong DEK must not succeed').toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BucketParseError);
    expect((err as Error).message).not.toMatch(/as Turtle/);
  });
});
