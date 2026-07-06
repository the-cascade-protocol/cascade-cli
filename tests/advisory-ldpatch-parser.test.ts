/**
 * Tests for the CAP LDPatch parser (TASK-4.1).
 *
 * Acceptance criteria covered:
 *   - Both example .ldpatch files parse to a complete AST.
 *   - Out-of-profile syntax (Delete / Cut / UpdateList) produces a clear
 *     "out of CAP profile" error with line + column.
 *   - Position info is preserved on every error.
 *   - The AST is JSON-serializable (round-trips through JSON.stringify).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseCap } from '../src/lib/advisory/ldpatch-parser.js';

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

describe.skipIf(!FIXTURES_AVAILABLE)('CAP LDPatch parser — example files', () => {
  it('parses example-brca2-reclassification.ldpatch into a complete AST', () => {
    const filePath = path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch');
    const src = fs.readFileSync(filePath, 'utf8');
    const result = parseCap(src);

    expect(result.errors).toEqual([]);
    expect(result.ast).not.toBeNull();
    const ast = result.ast!;

    // Prefixes resolved
    expect(ast.prefixes.advisory).toBe('https://ns.cascadeprotocol.org/advisory/v1#');
    expect(ast.prefixes.genomics).toBe('https://ns.cascadeprotocol.org/genomics/v1#');
    expect(ast.prefixes.prov).toBe('http://www.w3.org/ns/prov#');

    // Envelope populated
    expect(ast.envelope.types).toContain(
      'https://ns.cascadeprotocol.org/advisory/v1#CascadeAdvisoryPatch',
    );
    expect(ast.envelope.profileVersion).toBe('0.1');
    expect(ast.envelope.advisoryClass).toBe(
      'https://ns.cascadeprotocol.org/advisory/v1#VariantReclassification',
    );
    expect(ast.envelope.issuer).toBe('https://clingen.org/affiliation/40016');
    expect(ast.envelope.humanSummary).toContain('BRCA2 c.5946delT');
    expect(ast.envelope.supersedes).toBe('urn:advisory:clingen-hbop-2024-08-12-007');

    // Bind on caId
    expect(ast.bind).not.toBeNull();
    expect(ast.bind!.variable).toBe('v');
    expect(ast.bind!.predicate).toBe('https://ns.cascadeprotocol.org/genomics/v1#caId');
    expect(ast.bind!.object).toMatchObject({ kind: 'literal', value: 'CA000123' });

    // One Add with 11 triples
    expect(ast.adds.length).toBe(1);
    expect(ast.adds[0]!.triples.length).toBe(11);
  });

  it('parses example-cpic-cyp2c19-warfarin.ldpatch into a complete AST', () => {
    const filePath = path.join(EXAMPLES_DIR, 'example-cpic-cyp2c19-warfarin.ldpatch');
    const src = fs.readFileSync(filePath, 'utf8');
    const result = parseCap(src);

    expect(result.errors).toEqual([]);
    expect(result.ast).not.toBeNull();
    const ast = result.ast!;

    expect(ast.envelope.advisoryClass).toBe(
      'https://ns.cascadeprotocol.org/advisory/v1#DrugInteraction',
    );
    expect(ast.envelope.issuer).toBe('https://cpicpgx.org/');
    expect(ast.envelope.humanSummary).toContain('CYP2C19');

    expect(ast.bind).not.toBeNull();
    expect(ast.bind!.variable).toBe('gene');
    expect(ast.bind!.predicate).toBe('https://ns.cascadeprotocol.org/genomics/v1#hgncId');
    expect(ast.bind!.object).toMatchObject({ kind: 'literal', value: 'HGNC:2621' });

    expect(ast.adds.length).toBe(1);
    expect(ast.adds[0]!.triples.length).toBeGreaterThan(0);
  });

  it('produces an AST that is JSON-serializable', () => {
    const filePath = path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch');
    const src = fs.readFileSync(filePath, 'utf8');
    const { ast } = parseCap(src);
    expect(ast).not.toBeNull();

    const json = JSON.stringify(ast);
    expect(json.length).toBeGreaterThan(100);
    // Round-trip back to make sure no functions / circular references slipped in.
    const round = JSON.parse(json);
    expect(round.envelope.profileVersion).toBe('0.1');
    expect(Array.isArray(round.adds)).toBe(true);
  });
});

describe('CAP LDPatch parser — out-of-profile syntax', () => {
  const envelope = `
@prefix advisory: <https://ns.cascadeprotocol.org/advisory/v1#> .
@prefix genomics: <https://ns.cascadeprotocol.org/genomics/v1#> .
@prefix xsd:      <http://www.w3.org/2001/XMLSchema#> .

<> a advisory:CascadeAdvisoryPatch ;
   advisory:profileVersion  "0.1" ;
   advisory:advisoryClass   advisory:VariantReclassification ;
   advisory:issuer          <https://example.org/issuer> ;
   advisory:issuedAt        "2026-05-04T00:00:00Z"^^xsd:dateTime ;
   advisory:humanSummary    "Stub summary." .
`;

  it('rejects Delete with an out-of-profile error and a location', () => {
    const src = `${envelope}
Delete { <urn:x> a genomics:Variant } .
`;
    const result = parseCap(src);
    expect(result.ast).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    const err = result.errors[0]!;
    expect(err.code).toBe('out_of_profile');
    expect(err.message).toMatch(/Delete/);
    expect(err.message).toMatch(/CAP profile/);
    expect(err.line).toBeGreaterThan(0);
    expect(err.col).toBeGreaterThan(0);
  });

  it('rejects Cut with an out-of-profile error', () => {
    const src = `${envelope}
Cut <urn:x> .
`;
    const result = parseCap(src);
    expect(result.ast).toBeNull();
    expect(result.errors[0]!.code).toBe('out_of_profile');
    expect(result.errors[0]!.message).toMatch(/Cut/);
  });

  it('rejects UpdateList with an out-of-profile error', () => {
    const src = `${envelope}
UpdateList <urn:x> <urn:p> 0 1 ( <urn:y> ) .
`;
    const result = parseCap(src);
    expect(result.ast).toBeNull();
    expect(result.errors[0]!.code).toBe('out_of_profile');
    expect(result.errors[0]!.message).toMatch(/UpdateList/);
  });

  it('rejects D shorthand (Delete) as out-of-profile', () => {
    const src = `${envelope}
D { <urn:x> a genomics:Variant } .
`;
    const result = parseCap(src);
    expect(result.ast).toBeNull();
    expect(result.errors[0]!.code).toBe('out_of_profile');
  });

  it('rejects @base directive', () => {
    const src = `@prefix advisory: <https://ns.cascadeprotocol.org/advisory/v1#> .
@base <http://example.com/> .
`;
    const result = parseCap(src);
    expect(result.ast).toBeNull();
    expect(result.errors[0]!.code).toBe('out_of_profile');
    expect(result.errors[0]!.message).toMatch(/@base/);
  });

  it('rejects multiple Bind clauses', () => {
    const src = `${envelope}
Bind ?v <https://example.org/binding>
   ?v genomics:caId "CA000123" .
Bind ?w <https://example.org/binding>
   ?w genomics:caId "CA000456" .
Add { <urn:x> a genomics:Variant } .
`;
    const result = parseCap(src);
    expect(result.ast).toBeNull();
    expect(result.errors[0]!.code).toBe('out_of_profile');
    expect(result.errors[0]!.message).toMatch(/Multiple Bind/);
  });

  it('preserves line/column info on syntax errors', () => {
    const src = `@prefix advisory: <https://ns.cascadeprotocol.org/advisory/v1#> .

Delete { <urn:x> a advisory:Foo } .
`;
    const result = parseCap(src);
    expect(result.ast).toBeNull();
    const err = result.errors[0]!;
    // 'Delete' appears on line 3
    expect(err.line).toBe(3);
    expect(err.col).toBeGreaterThan(0);
  });
});

describe('CAP LDPatch parser — well-formed minimal documents', () => {
  it('accepts a minimal advisory with envelope, Bind, and Add', () => {
    const src = `@prefix advisory: <https://ns.cascadeprotocol.org/advisory/v1#> .
@prefix genomics: <https://ns.cascadeprotocol.org/genomics/v1#> .
@prefix xsd:      <http://www.w3.org/2001/XMLSchema#> .

<> a advisory:CascadeAdvisoryPatch ;
   advisory:profileVersion "0.1" ;
   advisory:advisoryClass  advisory:VariantReclassification ;
   advisory:issuer         <https://example.org/issuer> ;
   advisory:issuedAt       "2026-05-04T00:00:00Z"^^xsd:dateTime ;
   advisory:humanSummary   "Minimal example." .

Bind ?v <https://example.org/binding>
   ?v genomics:caId "CA000123" .

Add {
  <urn:x> a genomics:VariantInterpretation ;
          genomics:variantInterpreted ?v .
} .
`;
    const result = parseCap(src);
    expect(result.errors).toEqual([]);
    expect(result.ast).not.toBeNull();
    expect(result.ast!.adds[0]!.triples.length).toBe(2);
  });

  it('accepts an advisory without a Bind clause (zero-or-one)', () => {
    const src = `@prefix advisory: <https://ns.cascadeprotocol.org/advisory/v1#> .
@prefix xsd:      <http://www.w3.org/2001/XMLSchema#> .

<> a advisory:CascadeAdvisoryPatch ;
   advisory:profileVersion "0.1" ;
   advisory:advisoryClass  advisory:VariantReclassification ;
   advisory:issuer         <https://example.org/issuer> ;
   advisory:issuedAt       "2026-05-04T00:00:00Z"^^xsd:dateTime ;
   advisory:humanSummary   "No-bind advisory." .

Add { <urn:x> a advisory:CascadeAdvisoryPatch } .
`;
    const result = parseCap(src);
    expect(result.errors).toEqual([]);
    expect(result.ast).not.toBeNull();
    expect(result.ast!.bind).toBeNull();
  });
});
