/**
 * Tests for the slice R3 edge families (root backlog 3.11 b/c): the FHIR
 * converters wire `resource.encounter` / `DocumentReference.context.encounter`
 * into `clinical:hasEncounter` and `reasonReference` into
 * `clinical:indicationReference`, both routed through R1's end-of-batch
 * resolve-or-drop machinery (placeholder -> real subject, or drop and count).
 *
 * The trimmed synthetic bundle (test-fixtures/graph-edges-r3-bundle.json) carries
 * one present Encounter referenced by four records (Condition, Observation,
 * Procedure, DocumentReference.context.encounter), one absent Encounter
 * (dropped), a reasonReference chain to a present Condition (twice) and to one
 * absent Condition (dropped). All data is synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import { convert } from '../src/lib/fhir-converter/index.js';
import { isReferencePlaceholder } from '../src/lib/fhir-converter/reference-resolution.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = resolve(__dirname, '../test-fixtures/graph-edges-r3-bundle.json');

const NS_CLIN = 'https://ns.cascadeprotocol.org/clinical/v1#';
const NS_HEALTH = 'https://ns.cascadeprotocol.org/health/v1#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const HAS_ENCOUNTER = NS_CLIN + 'hasEncounter';
const INDICATION = NS_CLIN + 'indicationReference';

describe('R3 encounter + indication edge resolution over a trimmed bundle', () => {
  it('resolves present encounter/indication refs, drops absent ones, reports the counts', async () => {
    const bundle = readFileSync(FIXTURE, 'utf-8');
    const result = await convert(bundle, 'fhir', 'turtle');
    expect(result.success).toBe(true);

    // --- Resolution stats: 4/5 hasEncounter, 2/3 indicationReference ---
    const stats = result.edgeResolution;
    expect(stats).toBeDefined();
    expect(stats!.byPredicate['clinical:hasEncounter']).toEqual({ resolved: 4, unresolved: 1 });
    expect(stats!.byPredicate['clinical:indicationReference']).toEqual({ resolved: 2, unresolved: 1 });

    // --- Census the serialized output ---
    const quads = new Parser({ format: 'Turtle' }).parse(result.output);
    const subjects = new Set(quads.filter(q => q.subject.termType === 'NamedNode').map(q => q.subject.value));

    const encounterSubject = quads.find(
      q => q.predicate.value === RDF_TYPE && q.object.value === NS_CLIN + 'Encounter',
    )?.subject.value;
    const conditionSubject = quads.find(
      q => q.predicate.value === RDF_TYPE && q.object.value === NS_HEALTH + 'ConditionRecord',
    )?.subject.value;
    expect(encounterSubject).toBeDefined();
    expect(conditionSubject).toBeDefined();

    const encounterEdges = quads.filter(q => q.predicate.value === HAS_ENCOUNTER);
    const indicationEdges = quads.filter(q => q.predicate.value === INDICATION);

    // Only resolved edges are written; the absent targets are dropped, not dangled.
    expect(encounterEdges).toHaveLength(4);
    expect(indicationEdges).toHaveLength(2);

    // Every hasEncounter edge points at the one present Encounter; every
    // indication edge points at the one present Condition.
    for (const e of encounterEdges) {
      expect(e.object.value).toBe(encounterSubject);
      expect(subjects.has(e.object.value)).toBe(true);
    }
    for (const e of indicationEdges) {
      expect(e.object.value).toBe(conditionSubject);
      expect(subjects.has(e.object.value)).toBe(true);
    }

    // No placeholder survived; no double urn:uuid: prefix was ever emitted.
    for (const q of quads) {
      if (q.object.termType === 'NamedNode') {
        expect(isReferencePlaceholder(q.object.value)).toBe(false);
        expect(q.object.value.startsWith('urn:uuid:urn:uuid:')).toBe(false);
      }
    }
  });

  it('is deterministic: same bundle produces the same edge objects', async () => {
    const bundle = readFileSync(FIXTURE, 'utf-8');
    const a = await convert(bundle, 'fhir', 'turtle');
    const b = await convert(bundle, 'fhir', 'turtle');

    const edgeObjects = (ttl: string): string[] => {
      const quads = new Parser({ format: 'Turtle' }).parse(ttl);
      return quads
        .filter(q => q.predicate.value === HAS_ENCOUNTER || q.predicate.value === INDICATION)
        .map(q => `${q.predicate.value} -> ${q.object.value}`)
        .sort();
    };

    expect(edgeObjects(a.output)).toEqual(edgeObjects(b.output));
    expect(edgeObjects(a.output).length).toBe(6);
  });
});
