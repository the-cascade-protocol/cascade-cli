/**
 * Tests for cross-record reference resolution (root backlog 2.6, slice R1).
 *
 * The FHIR converters emit each cross-record edge (clinical:hasLabResult,
 * coverage:relatedClaim) as a placeholder that the batch loop rewrites to the
 * referenced record's real minted subject IRI, or drops and counts when the
 * target is not in the bundle. These tests lock in:
 *   - `parseReference` normalization (urn:uuid single/double, relative, absolute)
 *   - end-to-end resolution over a trimmed synthetic bundle: resolved edges point
 *     at real subjects, absent-target edges are NOT written, and the unresolved
 *     count is reported.
 *
 * All data is synthetic and PHI-free (test-fixtures/reference-resolution-bundle.json).
 */

import { describe, it, expect } from 'vitest';
import { DataFactory, Parser } from 'n3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import { convert } from '../src/lib/fhir-converter/index.js';
import { NS } from '../src/lib/fhir-converter/types.js';
import {
  parseReference,
  referencePlaceholder,
  isReferencePlaceholder,
  decodeReferencePlaceholder,
  buildResourceRefsFromQuads,
} from '../src/lib/fhir-converter/reference-resolution.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = resolve(__dirname, '../test-fixtures/reference-resolution-bundle.json');

const CLIN_HAS_LAB_RESULT = 'https://ns.cascadeprotocol.org/clinical/v1#hasLabResult';
const COV_RELATED_CLAIM = 'https://ns.cascadeprotocol.org/coverage/v1#relatedClaim';

// ---------------------------------------------------------------------------

describe('parseReference (R1 normalization)', () => {
  it('parses a relative FHIR reference', () => {
    expect(parseReference('Observation/123')).toEqual({ resourceType: 'Observation', id: '123' });
  });

  it('parses a urn:uuid fullUrl reference with no type', () => {
    expect(parseReference('urn:uuid:abc-def')).toEqual({ id: 'abc-def' });
  });

  it('collapses an accidental double urn:uuid prefix', () => {
    expect(parseReference('urn:uuid:urn:uuid:abc')).toEqual({ id: 'abc' });
  });

  it('parses an absolute URL reference', () => {
    expect(parseReference('https://example.org/fhir/Claim/42')).toEqual({ resourceType: 'Claim', id: '42' });
  });

  it('drops a FHIR version suffix', () => {
    expect(parseReference('Observation/123/_history/2')).toEqual({ resourceType: 'Observation', id: '123' });
  });

  it('returns an id-only result for a bare id', () => {
    expect(parseReference('bare-id')).toEqual({ id: 'bare-id' });
  });

  it('returns null for empty input', () => {
    expect(parseReference('')).toBeNull();
    expect(parseReference('   ')).toBeNull();
  });
});

describe('reference placeholder round-trip (R1)', () => {
  it('encodes and decodes a raw reference losslessly', () => {
    const raw = 'urn:uuid:some/weird?ref';
    const ph = referencePlaceholder(raw);
    expect(isReferencePlaceholder(ph)).toBe(true);
    expect(decodeReferencePlaceholder(ph)).toBe(raw);
  });

  it('does not classify a normal IRI as a placeholder', () => {
    expect(isReferencePlaceholder('urn:uuid:abc')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('cross-record edge resolution over a trimmed bundle (R1)', () => {
  it('resolves present references, drops absent ones, and reports the counts', async () => {
    const bundle = readFileSync(FIXTURE, 'utf-8');
    const result = await convert(bundle, 'fhir', 'turtle');
    expect(result.success).toBe(true);

    // --- Resolution stats: 2/3 hasLabResult, 1/2 relatedClaim ---
    const stats = result.edgeResolution;
    expect(stats).toBeDefined();
    expect(stats!.byPredicate['clinical:hasLabResult']).toEqual({ resolved: 2, unresolved: 1 });
    expect(stats!.byPredicate['coverage:relatedClaim']).toEqual({ resolved: 1, unresolved: 1 });
    expect(stats!.resolved).toBe(3);
    expect(stats!.unresolved).toBe(2);

    // --- Census the serialized output ---
    const quads = new Parser({ format: 'Turtle' }).parse(result.output);
    const subjects = new Set(quads.filter(q => q.subject.termType === 'NamedNode').map(q => q.subject.value));

    const labEdges = quads.filter(q => q.predicate.value === CLIN_HAS_LAB_RESULT);
    const claimEdges = quads.filter(q => q.predicate.value === COV_RELATED_CLAIM);

    // Only resolved edges are written (the absent targets are dropped, not dangled).
    expect(labEdges).toHaveLength(2);
    expect(claimEdges).toHaveLength(1);

    // Every written edge points at a real record subject in this pod.
    for (const e of [...labEdges, ...claimEdges]) {
      expect(e.object.termType).toBe('NamedNode');
      expect(subjects.has(e.object.value), `edge object ${e.object.value} should be a record subject`).toBe(true);
    }

    // No placeholder survived, and no double urn:uuid: prefix was ever emitted.
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
        .filter(q => q.predicate.value === CLIN_HAS_LAB_RESULT || q.predicate.value === COV_RELATED_CLAIM)
        .map(q => `${q.predicate.value} -> ${q.object.value}`)
        .sort();
    };

    expect(edgeObjects(a.output)).toEqual(edgeObjects(b.output));
    expect(edgeObjects(a.output).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// buildResourceRefsFromQuads (R5, root 2.11): rebuild the resolution index from
// serialized pod quads for the end-of-import (once-per-invocation) pass.
// ---------------------------------------------------------------------------

describe('buildResourceRefsFromQuads (R5 index reconstruction)', () => {
  const S1 = 'urn:uuid:1111';
  const S2 = 'urn:uuid:2222';

  it('indexes a record by its persisted source id and subject', () => {
    const quads = [
      makeQuad(namedNode(S1), namedNode(NS.rdf + 'type'), namedNode(NS.health + 'LabResultRecord')),
      makeQuad(namedNode(S1), namedNode(NS.health + 'sourceRecordId'), literal('obs-1')),
    ];
    expect(buildResourceRefsFromQuads(quads)).toEqual([
      { resourceType: '', id: 'obs-1', subject: S1 },
    ]);
  });

  it('fills resourceType from fhirResourceType when the record carries it', () => {
    const quads = [
      makeQuad(namedNode(S1), namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'LaboratoryReport')),
      makeQuad(namedNode(S1), namedNode(NS.clinical + 'sourceRecordId'), literal('dr-1')),
      makeQuad(namedNode(S1), namedNode(NS.clinical + 'fhirResourceType'), literal('DiagnosticReport')),
    ];
    expect(buildResourceRefsFromQuads(quads)).toEqual([
      { resourceType: 'DiagnosticReport', id: 'dr-1', subject: S1 },
    ]);
  });

  it('skips non-record subjects (no rdf:type) and records with no source id', () => {
    const quads = [
      // A record with a type but no source id -> not indexable (no join key).
      makeQuad(namedNode(S1), namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'Encounter')),
      // A bare subject that is not a record (an edge object leftover) -> ignored.
      makeQuad(namedNode(S2), namedNode(NS.health + 'sourceRecordId'), literal('orphan')),
    ];
    expect(buildResourceRefsFromQuads(quads)).toEqual([]);
  });

  it('feeds resolveReferenceEdges so a relative reference resolves by bare id', async () => {
    // Rebuild the index from a target record, then resolve a placeholder edge
    // that points at it with a typed relative reference.
    const { resolveReferenceEdges } = await import('../src/lib/fhir-converter/reference-resolution.js');
    const quads = [
      makeQuad(namedNode(S1), namedNode(NS.rdf + 'type'), namedNode(NS.health + 'LabResultRecord')),
      makeQuad(namedNode(S1), namedNode(NS.health + 'sourceRecordId'), literal('obs-9')),
      makeQuad(
        namedNode(S2),
        namedNode(NS.clinical + 'hasLabResult'),
        namedNode(referencePlaceholder('Observation/obs-9')),
      ),
    ];
    const refs = buildResourceRefsFromQuads(quads);
    const { quads: out, stats } = resolveReferenceEdges(quads, refs);
    expect(stats.resolved).toBe(1);
    expect(stats.unresolved).toBe(0);
    const edge = out.find((q) => q.predicate.value === NS.clinical + 'hasLabResult');
    expect(edge?.object.value).toBe(S1);
  });
});
