/**
 * Recovering the name of a record from the section NARRATIVE when the structured
 * code does not carry one.
 *
 * C-CDA lets an entry name its concept in the attested narrative and point at it
 * from the structured data — `<code><originalText><reference value="#id"/>` —
 * instead of repeating the name in a `@displayName` attribute. Handlers that read
 * `@displayName` only therefore dropped the name entirely: `health:testName` and
 * `health:conditionName` are `sh:minCount 1`, so every such record failed
 * validation for missing a name the document plainly stated.
 *
 * `medications.ts` already resolved these references and `allergies.ts` carries a
 * standing note asking for the same thing, so the resolver moved into
 * `narrative-reference.ts` and the sites call it rather than each growing a copy.
 *
 * THE GUARD IS THE HALF THAT MATTERS. When a reference does not resolve — no
 * element declares that ID, or the element it names is empty — nothing is
 * emitted. The `minCount` violation then fires, and it is TRUE: the converter has
 * no name for that record. Substituting a placeholder would convert a visible
 * failure into a plausible-looking record, which is the worse outcome.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';
import type { Quad } from 'n3';
import { convertCcda } from '../src/lib/ccda-converter/index.js';
import { parseCcdaXml } from '../src/lib/ccda-converter/parser.js';
import {
  buildNarrativeIdMap,
  narrativeTextFor,
  resolveNarrativeName,
} from '../src/lib/ccda-converter/narrative-reference.js';
import { loadShapes, validateTurtle } from '../src/lib/shacl-validator.js';
import {
  assertOnlyKnownViolations,
} from './known-shacl-gaps.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES = path.resolve(__dirname, '../test-fixtures');

const HEALTH = 'https://ns.cascadeprotocol.org/health/v1#';
const CLINICAL = 'https://ns.cascadeprotocol.org/clinical/v1#';
const CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';

async function convertFixture(name: string): Promise<Quad[]> {
  const xml = fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
  const result = await convertCcda(xml, {
    sourceSystem: 'TestSystem',
    importedAt: '2026-01-01T00:00:00Z',
  });
  expect(result.errors, `conversion errors: ${result.errors.join(', ')}`).toHaveLength(0);
  return new Parser().parse(result.output);
}

/** The record whose cascade:sourceRecordId ends with `suffix`, as a predicate map. */
function recordBySourceId(quads: Quad[], suffix: string): Record<string, string[]> {
  const idQuad = quads.find(
    (q) => q.predicate.value === CASCADE + 'sourceRecordId' && q.object.value.endsWith(suffix),
  );
  expect(idQuad, `no record with sourceRecordId ending "${suffix}"`).toBeDefined();
  const out: Record<string, string[]> = {};
  for (const q of quads) {
    if (q.subject.value === idQuad!.subject.value) (out[q.predicate.value] ??= []).push(q.object.value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

describe('narrative-reference — ID map and reference resolution', () => {
  const sectionText = parseCcdaXml(
    `<text><table><tbody>
       <tr><td><content ID="a">Hemoglobin</content></td><td>13.2</td></tr>
       <tr><td><content ID="blank">   </content></td><td>7</td></tr>
       <tr><td><paragraph ID="nested">Serum <content>sodium</content></paragraph></td></tr>
     </tbody></table></text>`,
  ).text;

  it('maps a narrative element ID to its text', () => {
    expect(buildNarrativeIdMap(sectionText).a).toBe('Hemoglobin');
  });

  it('flattens nested markup under one ID into a single string', () => {
    // Pinned as-is, not as it should read. The parser hands back mixed content as
    // an object, so the flattener walks it in KEY order, and a bare text node
    // interleaved with a child element does not come back in document order —
    // here "Serum <content>sodium</content>" flattens to "sodium Serum". This
    // behaviour is inherited unchanged from the medications resolver, and
    // `clinical:drugName` feeds the medication identity key, so correcting the
    // order would re-mint medication IRIs. That is a separate change with its own
    // consequence; what matters here is that the text is not LOST.
    expect(buildNarrativeIdMap(sectionText).nested).toBe('sodium Serum');
  });

  it('does not map an ID whose element holds only whitespace', () => {
    expect(buildNarrativeIdMap(sectionText)).not.toHaveProperty('blank');
  });

  it('resolves a code originalText reference', () => {
    const map = buildNarrativeIdMap(sectionText);
    const codeEl = { originalText: { reference: { '@_value': '#a' } } };
    expect(resolveNarrativeName(codeEl, map)).toBe('Hemoglobin');
  });

  it('returns empty string for a reference no element declares', () => {
    const map = buildNarrativeIdMap(sectionText);
    const codeEl = { originalText: { reference: { '@_value': '#nope' } } };
    expect(resolveNarrativeName(codeEl, map)).toBe('');
  });

  it('returns empty string for a reference to a blank element', () => {
    const map = buildNarrativeIdMap(sectionText);
    const codeEl = { originalText: { reference: { '@_value': '#blank' } } };
    expect(resolveNarrativeName(codeEl, map)).toBe('');
  });

  it('reads text carried inline in originalText instead of behind a reference', () => {
    expect(resolveNarrativeName({ originalText: 'Troponin-T' }, {})).toBe('Troponin-T');
    expect(resolveNarrativeName({ originalText: { '#text': 'Troponin-T' } }, {})).toBe('Troponin-T');
  });

  it('resolves a reference from any container, not just originalText', () => {
    const map = buildNarrativeIdMap(sectionText);
    expect(narrativeTextFor({ reference: { '@_value': '#a' } }, map)).toBe('Hemoglobin');
  });

  it('is empty, never undefined, for absent input', () => {
    expect(resolveNarrativeName(undefined, {})).toBe('');
    expect(narrativeTextFor(undefined, {})).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Lab test names
// ---------------------------------------------------------------------------

describe('C-CDA lab testName from the section narrative', () => {
  it('uses the referenced narrative text when the code has no displayName', async () => {
    const quads = await convertFixture('ccda-narrative-names.xml');
    expect(recordBySourceId(quads, 'NN-LAB-NARRATIVE')[HEALTH + 'testName']).toEqual(['Hemoglobin']);
  });

  it('uses originalText carried inline', async () => {
    const quads = await convertFixture('ccda-narrative-names.xml');
    expect(recordBySourceId(quads, 'NN-LAB-INLINE')[HEALTH + 'testName']).toEqual([
      'White blood cell count',
    ]);
  });

  it("resolves a reference on the observation's own <text>", async () => {
    const quads = await convertFixture('ccda-narrative-names.xml');
    expect(recordBySourceId(quads, 'NN-LAB-OBS-TEXT')[HEALTH + 'testName']).toEqual([
      'Platelet count',
    ]);
  });

  it('prefers the structured displayName over the narrative wording', async () => {
    const quads = await convertFixture('ccda-narrative-names.xml');
    expect(recordBySourceId(quads, 'NN-LAB-DISPLAYNAME')[HEALTH + 'testName']).toEqual([
      'Potassium [Moles/volume] in Serum or Plasma',
    ]);
  });

  it('emits no testName when the reference does not resolve', async () => {
    const quads = await convertFixture('ccda-narrative-names-unresolved.xml');
    expect(recordBySourceId(quads, 'NR-LAB-DANGLING')[HEALTH + 'testName']).toBeUndefined();
  });

  it('emits no testName when the referenced element is blank', async () => {
    const quads = await convertFixture('ccda-narrative-names-unresolved.xml');
    expect(recordBySourceId(quads, 'NR-LAB-BLANK')[HEALTH + 'testName']).toBeUndefined();
  });

  it('leaves the minCount violation standing for an unresolvable reference', async () => {
    const xml = fs.readFileSync(path.join(FIXTURES, 'ccda-narrative-names-unresolved.xml'), 'utf-8');
    const result = await convertCcda(xml, {
      sourceSystem: 'TestSystem',
      importedAt: '2026-01-01T00:00:00Z',
    });
    const { store, shapeFiles } = loadShapes();
    const validation = validateTurtle(result.output, store, shapeFiles, 'unresolved');
    const violations = validation.results.filter((r) => r.severity === 'violation');
    // Two lab results, neither nameable from this document: two true violations
    // and nothing else. If this ever reads zero, the converter started inventing
    // names.
    expect(violations.map((v) => v.property).sort()).toEqual(['testName', 'testName']);
  });
});

// ---------------------------------------------------------------------------
// The same pattern in the other sections
// ---------------------------------------------------------------------------

describe('C-CDA condition and procedure names from the section narrative', () => {
  it('problems: conditionName resolves from the value originalText reference', async () => {
    const quads = await convertFixture('ccda-narrative-names.xml');
    expect(recordBySourceId(quads, 'NN-PROB-OBS')[HEALTH + 'conditionName']).toEqual([
      'Seasonal allergic rhinitis',
    ]);
  });

  it('procedures: procedureName resolves from the code originalText reference', async () => {
    const quads = await convertFixture('ccda-narrative-names.xml');
    const rec = recordBySourceId(quads, 'NN-PROC-001');
    // On clinical:procedureName since clinical v1.15, and BOTH halves are pinned.
    // Asserting only the first would still pass if the converter dual-wrote, and a
    // dual write is the outcome the ruling explicitly did not take: the shape's
    // sh:or already covers pods holding the old spelling, so writing both would add
    // a duplicate triple to every new record for no validation benefit.
    expect(rec[CLINICAL + 'procedureName']).toEqual(['Colonoscopy']);
    expect(rec[HEALTH + 'procedureName']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Identity does not move
// ---------------------------------------------------------------------------

describe('C-CDA narrative names do not move record identity', () => {
  it('an id-less lab keeps its content-tier IRI after gaining a narrative name', async () => {
    // The content key still reads the STRUCTURED displayName only. Widening it to
    // include a name recovered from narrative text is a separate decision with a
    // separate consequence (every such record re-mints), so this change does not
    // make it, and this golden value is what says so.
    const quads = await convertFixture('ccda-narrative-names.xml');
    const named = quads.find(
      (q) => q.predicate.value === HEALTH + 'testName' && q.object.value === 'Sodium level',
    );
    expect(named, 'the id-less lab result').toBeDefined();
    expect(named!.subject.value).toBe('urn:uuid:225e19ec-c7b9-52de-93ae-419cbeedb1d5');
  });
});

// ---------------------------------------------------------------------------
// SHACL
// ---------------------------------------------------------------------------

describe('C-CDA narrative names — SHACL', () => {
  it('leaves no testName or conditionName violation on the resolvable fixture', async () => {
    const xml = fs.readFileSync(path.join(FIXTURES, 'ccda-narrative-names.xml'), 'utf-8');
    const result = await convertCcda(xml, {
      sourceSystem: 'TestSystem',
      importedAt: '2026-01-01T00:00:00Z',
    });
    const { store, shapeFiles } = loadShapes();
    const validation = validateTurtle(result.output, store, shapeFiles, 'ccda-narrative-names.xml');
    const violations = validation.results.filter((r) => r.severity === 'violation');

    // The `procedureName` gap this file used to document is CLOSED as of clinical
    // v1.15: `procedures.ts` writes `clinical:procedureName`, the spelling
    // `clinical:ProcedureShape` names, so the record no longer fails for missing a
    // name it was carrying. `known-shacl-gaps.ts` now holds no entries, and its
    // matcher is kept here rather than deleted so the assertion stays "no
    // violations except the known ones" and the next gap has somewhere to land.
    assertOnlyKnownViolations(violations);
    expect(violations, 'the C-CDA converter leaves no SHACL violation on this fixture').toEqual([]);
  });
});
