/**
 * Tests for the CAP selector evaluator (TASK-4.4).
 *
 * Acceptance:
 *   - Single-Bind, single match → 1 binding.
 *   - Single-Bind, zero matches → 0 bindings (advisory inapplicable).
 *   - Single-Bind, multiple matches → all bindings.
 *   - Sub-100ms evaluation against a 10k-record synthetic pod.
 *
 * The synthetic pod is built directly in n3 — much faster + more deterministic
 * than going through Turtle serialization.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Store, DataFactory } from 'n3';
import { parseCap } from '../src/lib/advisory/ldpatch-parser.js';
import { evaluateSelector } from '../src/lib/advisory/selector.js';
import { parseTurtle } from '../src/lib/turtle-parser.js';

const { namedNode, literal, quad } = DataFactory;

const EXAMPLES_DIR = path.resolve(
  os.homedir(),
  'Development/cascadeprotocol.org/drafts/advisory-v1',
);

const HGNC_ID = 'https://ns.cascadeprotocol.org/genomics/v1#hgncId';
const CA_ID = 'https://ns.cascadeprotocol.org/genomics/v1#caId';
const CLINVAR_ID = 'https://ns.cascadeprotocol.org/genomics/v1#clinvarVariationId';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const VARIANT = 'https://ns.cascadeprotocol.org/genomics/v1#Variant';

/** Build a tiny pod with one variant carrying CAid CA000123 (BRCA2 example). */
function buildBrca2Pod(): Store {
  const s = new Store();
  s.addQuad(
    quad(
      namedNode('urn:pod:variant:1'),
      namedNode(RDF_TYPE),
      namedNode(VARIANT),
    ),
  );
  s.addQuad(
    quad(
      namedNode('urn:pod:variant:1'),
      namedNode(CA_ID),
      literal('CA000123'),
    ),
  );
  return s;
}

/** Synthetic 10k-record pod with one matching variant. */
function build10kPod(matchingHgnc: string): Store {
  const s = new Store();
  // Insert 9_999 unrelated variants (different HGNC IDs) and one matching.
  for (let i = 0; i < 9_999; i++) {
    s.addQuad(
      quad(
        namedNode(`urn:pod:variant:${i}`),
        namedNode(RDF_TYPE),
        namedNode(VARIANT),
      ),
    );
    s.addQuad(
      quad(
        namedNode(`urn:pod:variant:${i}`),
        namedNode(HGNC_ID),
        literal(`HGNC:${100000 + i}`),
      ),
    );
  }
  // The one match.
  s.addQuad(
    quad(
      namedNode('urn:pod:variant:match'),
      namedNode(RDF_TYPE),
      namedNode(VARIANT),
    ),
  );
  s.addQuad(
    quad(
      namedNode('urn:pod:variant:match'),
      namedNode(HGNC_ID),
      literal(matchingHgnc),
    ),
  );
  return s;
}

describe('CAP selector evaluator — single match', () => {
  it('returns 1 binding when the BRCA2 example matches one record', () => {
    const src = fs.readFileSync(
      path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch'),
      'utf8',
    );
    const { ast } = parseCap(src);
    expect(ast).not.toBeNull();
    const pod = buildBrca2Pod();
    const matches = evaluateSelector(ast!, pod);
    expect(matches.length).toBe(1);
    expect(matches[0]!.variable).toBe('v');
    expect(matches[0]!.boundIri).toBe('urn:pod:variant:1');
  });
});

describe('CAP selector evaluator — zero matches (inapplicable)', () => {
  it('returns 0 bindings when no record carries the bound identifier', () => {
    const src = fs.readFileSync(
      path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch'),
      'utf8',
    );
    const { ast } = parseCap(src);
    const empty = new Store();
    expect(evaluateSelector(ast!, empty)).toEqual([]);
  });

  it('returns 0 bindings when records have the predicate but a different value', () => {
    const src = fs.readFileSync(
      path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch'),
      'utf8',
    );
    const { ast } = parseCap(src);
    const pod = new Store();
    pod.addQuad(
      quad(
        namedNode('urn:pod:variant:other'),
        namedNode(CA_ID),
        literal('CA999999'),
      ),
    );
    expect(evaluateSelector(ast!, pod)).toEqual([]);
  });
});

describe('CAP selector evaluator — multiple matches', () => {
  it('returns all bindings when multiple records share the bound HGNC ID', () => {
    const src = fs.readFileSync(
      path.join(EXAMPLES_DIR, 'example-cpic-cyp2c19-warfarin.ldpatch'),
      'utf8',
    );
    const { ast } = parseCap(src);
    expect(ast).not.toBeNull();

    const pod = new Store();
    for (const i of [1, 2, 3]) {
      pod.addQuad(
        quad(
          namedNode(`urn:pod:gene:${i}`),
          namedNode(HGNC_ID),
          literal('HGNC:2621'),
        ),
      );
    }
    // Plus a non-matching record:
    pod.addQuad(
      quad(
        namedNode('urn:pod:gene:other'),
        namedNode(HGNC_ID),
        literal('HGNC:9999'),
      ),
    );

    const matches = evaluateSelector(ast!, pod);
    expect(matches.length).toBe(3);
    expect(matches.map((m) => m.boundIri).sort()).toEqual([
      'urn:pod:gene:1',
      'urn:pod:gene:2',
      'urn:pod:gene:3',
    ]);
    for (const m of matches) expect(m.variable).toBe('gene');
  });
});

describe('CAP selector evaluator — performance', () => {
  it('matches against a 10k-record pod in under 100ms', () => {
    const src = fs.readFileSync(
      path.join(EXAMPLES_DIR, 'example-cpic-cyp2c19-warfarin.ldpatch'),
      'utf8',
    );
    const { ast } = parseCap(src);
    const pod = build10kPod('HGNC:2621');

    const t0 = performance.now();
    const matches = evaluateSelector(ast!, pod);
    const elapsed = performance.now() - t0;

    expect(matches.length).toBe(1);
    expect(matches[0]!.boundIri).toBe('urn:pod:variant:match');
    // Sub-100ms target per acceptance criteria.
    expect(elapsed).toBeLessThan(100);
  });
});

describe('CAP selector evaluator — predicate variants', () => {
  it('matches on clinvarVariationId', () => {
    const cap = `
@prefix advisory: <https://ns.cascadeprotocol.org/advisory/v1#> .
@prefix genomics: <https://ns.cascadeprotocol.org/genomics/v1#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<> a advisory:CascadeAdvisoryPatch ;
   advisory:profileVersion "0.1" ;
   advisory:advisoryClass advisory:VariantReclassification ;
   advisory:issuer <https://example.org/issuer> ;
   advisory:issuedAt "2026-01-01T00:00:00Z"^^xsd:dateTime ;
   advisory:humanSummary "Test." .

Bind ?v <https://example.org/binding>
   ?v genomics:clinvarVariationId "30880" .

Add { ?v genomics:annotation "x" . } .
`;
    const { ast } = parseCap(cap);
    expect(ast).not.toBeNull();

    // Use the actual conformance fixture if present; otherwise synthesize.
    const pod = new Store();
    pod.addQuad(
      quad(
        namedNode('urn:pod:cgexample:variant'),
        namedNode(CLINVAR_ID),
        literal('30880'),
      ),
    );
    const matches = evaluateSelector(ast!, pod);
    expect(matches.length).toBe(1);
    expect(matches[0]!.boundIri).toBe('urn:pod:cgexample:variant');
  });

  it('matches against an actual conformance fixture (cgexample)', () => {
    const fixturePath = path.resolve(
      os.homedir(),
      'Development/conformance/fixtures/genomics/fhir-genomics-ig/Bundle-bundle-cgexample.expected.ttl',
    );
    if (!fs.existsSync(fixturePath)) {
      // Fixture not available; skip rather than fail.
      return;
    }
    const ttl = fs.readFileSync(fixturePath, 'utf8');
    const { store } = parseTurtle(ttl);

    const cap = `
@prefix advisory: <https://ns.cascadeprotocol.org/advisory/v1#> .
@prefix genomics: <https://ns.cascadeprotocol.org/genomics/v1#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<> a advisory:CascadeAdvisoryPatch ;
   advisory:profileVersion "0.1" ;
   advisory:advisoryClass advisory:VariantReclassification ;
   advisory:issuer <https://example.org/issuer> ;
   advisory:issuedAt "2026-01-01T00:00:00Z"^^xsd:dateTime ;
   advisory:humanSummary "Test." .

Bind ?v <https://example.org/binding>
   ?v genomics:clinvarVariationId "30880" .

Add { ?v genomics:annotation "x" . } .
`;
    const { ast } = parseCap(cap);
    const matches = evaluateSelector(ast!, store);
    // The cgexample fixture has a Variant with clinvarVariationId "30880".
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

describe('CAP selector evaluator — edge cases', () => {
  it('returns one empty binding when ast.bind is null (unconditional)', () => {
    // An AST with no Bind (validator allows zero Binds).
    const ast = {
      prefixes: {},
      envelope: { types: [], extra: [] },
      bind: null,
      adds: [{ triples: [], pos: { line: 1, col: 1 } }],
    };
    const matches = evaluateSelector(ast as never, new Store());
    expect(matches.length).toBe(1);
    expect(matches[0]!.boundIri).toBe('');
  });
});
