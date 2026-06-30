/**
 * Phase 6 (G6): provenance-aware resolution.
 *
 *  - the merge winner is chosen with a provenance-class boost on top of source
 *    trust (Checkup evidenceWeight parity), so a high-provenance record wins
 *    even from an equal-trust source;
 *  - an opt-in cross-provenance guard flags a would-be merge that spans
 *    provenance classes instead of silently merging across them.
 */

import { describe, it, expect } from 'vitest';
import { runReconciliation } from '../src/lib/reconciler.js';

const PREFIXES = `
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
`;
const RX = '<https://ns.cascadeprotocol.org/rxnorm/29046>';

/** Identical lisinopril record except for URI / source / provenance class. */
function med(uri: string, provenanceClass: string): string {
  return `${PREFIXES}
<${uri}> a clinical:Medication ;
  clinical:drugName "Lisinopril" ;
  clinical:rxNormCode ${RX} ;
  clinical:dosage "10 mg" ;
  clinical:status "active" ;
  clinical:provenanceClass "${provenanceClass}" .
`;
}

describe('provenance-aware resolution', () => {
  it('picks the higher-provenance record as the merge winner (equal trust)', async () => {
    const result = await runReconciliation([
      // Both from default-trust sources; healthKitFHIR (+0.30) should beat imported (+0.05).
      { content: med('urn:med:imported', 'imported'), systemName: 'SourceA' },
      { content: med('urn:med:hk', 'healthKitFHIR'), systemName: 'SourceB' },
    ]);

    expect(result.report.summary.finalRecordCount).toBe(1);
    const t = result.report.transformations[0] as { canonicalUri?: string };
    expect(t.canonicalUri).toBe('urn:med:hk');
  });

  it('merges across provenance classes by default', async () => {
    const result = await runReconciliation([
      { content: med('urn:med:imported', 'imported'), systemName: 'SourceA' },
      { content: med('urn:med:hk', 'healthKitFHIR'), systemName: 'SourceB' },
    ]);
    expect(result.report.summary.exactDuplicatesRemoved).toBe(1);
    expect(result.report.summary.conflictsUnresolved).toBe(0);
  });

  it('flags a cross-provenance merge when the guard is opted in', async () => {
    const result = await runReconciliation(
      [
        { content: med('urn:med:imported', 'imported'), systemName: 'SourceA' },
        { content: med('urn:med:hk', 'healthKitFHIR'), systemName: 'SourceB' },
      ],
      { allowCrossProvenanceMerge: false },
    );
    expect(result.report.summary.conflictsUnresolved).toBe(1);
    expect(result.report.summary.exactDuplicatesRemoved).toBe(0);
  });

  it('does NOT flag same-provenance merges even with the guard on', async () => {
    const result = await runReconciliation(
      [
        { content: med('urn:med:a', 'imported'), systemName: 'SourceA' },
        { content: med('urn:med:b', 'imported'), systemName: 'SourceB' },
      ],
      { allowCrossProvenanceMerge: false },
    );
    expect(result.report.summary.conflictsUnresolved).toBe(0);
    expect(result.report.summary.exactDuplicatesRemoved).toBe(1);
  });
});
