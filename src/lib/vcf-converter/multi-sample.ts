/**
 * Multi-sample handling + SequencingRun emission.
 *
 * Stub at TASK-3A.1 — full implementation lands in TASK-3A.4.
 * The stub emits a SequencingRun with just the IRI and rdf:type so the
 * orchestrator's prov:wasGeneratedBy pointer has a real subject.
 *
 * TASK-3A.4 fills in:
 *   - genomics:referenceGenome from header.reference.
 *   - genomics:variantCallerVersion from header.source.
 *   - genomics:fileGenerationDate from header.fileDate.
 *   - per-sample IRIs derived from header.samples + header.sampleColumns
 *     (used by record.ts for genomics:observedIn — still gated on vocab).
 */

import { DataFactory, type Quad } from 'n3';
import type { ImportContext } from '../import-types.js';
import { NS_ALL } from './types.js';
import { deterministicUuid, tripleType, tripleStr } from '../fhir-converter/types.js';
import type { VcfHeader } from './types.js';
import type { ParsedRecord } from './record.js';

const { namedNode } = DataFactory;
void namedNode; // intentionally exported via tripleType

/**
 * Mint a SequencingRun IRI deterministically from input-path + ##fileDate +
 * ##source — that combination is stable across re-runs over the same VCF.
 */
function mintSequencingRunIri(header: VcfHeader, ctx: ImportContext): string {
  const parts = [
    'SequencingRun',
    ctx.inputPath ?? '<stdin>',
    header.fileDate ?? '',
    header.source ?? '',
    header.reference ?? '',
  ].join('|');
  return `urn:uuid:${deterministicUuid(parts)}`;
}

export function emitSequencingRun(header: VcfHeader, ctx: ImportContext): ParsedRecord {
  const iri = mintSequencingRunIri(header, ctx);
  const quads: Quad[] = [];

  quads.push(tripleType(iri, NS_ALL.genomics + 'SequencingRun'));
  // Stub ID — the full property set lands in TASK-3A.4.
  quads.push(tripleStr(iri, NS_ALL.cascade + 'sourceFormat', 'VCF'));

  return {
    iri,
    cascadeType: 'genomics:SequencingRun',
    sourceId: ctx.inputPath ?? '<stdin>',
    quads,
  };
}
