/**
 * Re-import importedAt duplication (root backlog 1.5, symptom 3).
 *
 * Passthrough subjects (clinical:ClinicalDocument, clinical:LaboratoryReport)
 * are carried verbatim and deduped by full quad identity. `clinical:importedAt`
 * is stamped fresh (`new Date().toISOString()`) on every conversion run while the
 * subject is content-hash-stable, so a re-import gives the same document a second
 * importedAt and it fails SHACL `sh:maxCount 1`. The reconciler now collapses
 * single-cardinality passthrough predicates to one value per subject (the
 * earliest, so it is stable across further re-imports). These tests lock that in.
 *
 * All data is synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { runReconciliation } from '../src/lib/reconciler.js';

const PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

const IMPORTED_AT = 'https://ns.cascadeprotocol.org/clinical/v1#importedAt';
const DOC_TITLE = 'https://ns.cascadeprotocol.org/clinical/v1#documentTitle';
const DOC = 'urn:uuid:doc-summary-0001';
const T1 = '2026-01-01T08:00:00.000Z';
const T2 = '2026-06-01T09:30:00.000Z';

/** The same passthrough ClinicalDocument as it is stamped on two import runs. */
function docTurtle(importedAt: string): string {
  return `${PREFIXES}
<${DOC}> a clinical:ClinicalDocument ;
  clinical:documentTitle "Summarization of Episode Note" ;
  clinical:importedAt "${importedAt}"^^xsd:dateTime .
`;
}

function objectsOf(ttl: string, subject: string, predicate: string): string[] {
  return new Parser({ format: 'Turtle' }).parse(ttl)
    .filter(q => q.subject.value === subject && q.predicate.value === predicate)
    .map(q => q.object.value);
}

describe('reconciler collapses re-imported importedAt to one value', () => {
  it('keeps exactly one importedAt (the earliest) when a document is re-imported', async () => {
    // Existing pod holds the T1 copy; a re-import brings the same document at T2.
    const result = await runReconciliation([
      { content: docTurtle(T1), systemName: 'existing-pod' },
      { content: docTurtle(T2), systemName: 'epic' },
    ]);

    const importedAt = objectsOf(result.turtle, DOC, IMPORTED_AT);
    expect(importedAt).toEqual([T1]); // exactly one, and it is the earliest

    // The document and its other single-value fields survive intact.
    expect(objectsOf(result.turtle, DOC, DOC_TITLE)).toEqual(['Summarization of Episode Note']);
  });

  it('is order-independent: the earliest wins regardless of input order', async () => {
    const result = await runReconciliation([
      { content: docTurtle(T2), systemName: 'epic' },
      { content: docTurtle(T1), systemName: 'existing-pod' },
    ]);
    expect(objectsOf(result.turtle, DOC, IMPORTED_AT)).toEqual([T1]);
  });

  it('leaves a single importedAt untouched (no reconcilable duplication)', async () => {
    const result = await runReconciliation([
      { content: docTurtle(T1), systemName: 'existing-pod' },
      // A second, unrelated document so a reconciliation pass actually runs.
      {
        content: `${PREFIXES}
<urn:uuid:doc-other> a clinical:ClinicalDocument ;
  clinical:documentTitle "Progress Note" ;
  clinical:importedAt "${T2}"^^xsd:dateTime .
`,
        systemName: 'epic',
      },
    ]);
    expect(objectsOf(result.turtle, DOC, IMPORTED_AT)).toEqual([T1]);
    expect(objectsOf(result.turtle, 'urn:uuid:doc-other', IMPORTED_AT)).toEqual([T2]);
  });

  it('is deterministic across runs', async () => {
    const inputs = [
      { content: docTurtle(T1), systemName: 'existing-pod' },
      { content: docTurtle(T2), systemName: 'epic' },
    ];
    const a = await runReconciliation(inputs);
    const b = await runReconciliation(inputs);
    expect(a.turtle).toBe(b.turtle);
  });
});
