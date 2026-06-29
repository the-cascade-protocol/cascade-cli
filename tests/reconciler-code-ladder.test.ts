/**
 * Phase 4 (S3): the medication matcher walks the weighted code ladder
 * (RxNorm > SNOMED > NDC > ATC > normalized name), so a coded pair matches even
 * without a shared RxNorm code. Before this, matchMedications stopped at RxNorm
 * + name and missed NDC-only / SNOMED-only duplicates.
 */

import { describe, it, expect } from 'vitest';
import { runReconciliation } from '../src/lib/reconciler.js';

const PREFIXES = `
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
`;

/** Build a clinical:Medication record carrying an arbitrary drugCode URI. */
function medWithCode(uri: string, drugName: string, codeUri: string): string {
  return `${PREFIXES}
<${uri}> a clinical:Medication ;
  clinical:drugName "${drugName}" ;
  clinical:drugCode <${codeUri}> ;
  clinical:status "active" .
`;
}

describe('medication matcher: code ladder beyond RxNorm', () => {
  it('matches an NDC-only pair (no RxNorm), differing display names', async () => {
    const ndc = 'http://hl7.org/fhir/sid/ndc/0071-0155';
    const result = await runReconciliation([
      // Brand vs generic display names, but the SAME NDC -> should dedupe.
      { content: medWithCode('urn:med:a', 'Zestril', ndc), systemName: 'PharmacyA' },
      { content: medWithCode('urn:med:b', 'Lisinopril', ndc), systemName: 'ClinicB' },
    ]);

    // One group emerges (the two collapsed), matched on the NDC code.
    expect(result.report.summary.totalInputRecords).toBe(2);
    expect(result.report.summary.finalRecordCount).toBe(1);
    const t = result.report.transformations[0] as { matchedOn?: string } | undefined;
    expect(t?.matchedOn).toContain('ndc:');
  });

  it('matches a SNOMED-only pair', async () => {
    const sct = 'http://snomed.info/sct/108774000';
    const result = await runReconciliation([
      { content: medWithCode('urn:med:a', 'Drug A', sct), systemName: 'PharmacyA' },
      { content: medWithCode('urn:med:b', 'Drug B', sct), systemName: 'ClinicB' },
    ]);

    expect(result.report.summary.finalRecordCount).toBe(1);
    const t = result.report.transformations[0] as { matchedOn?: string } | undefined;
    expect(t?.matchedOn).toContain('snomed:');
  });

  it('does NOT match two different NDC codes', async () => {
    const result = await runReconciliation([
      { content: medWithCode('urn:med:a', 'Drug A', 'http://hl7.org/fhir/sid/ndc/0071-0155'), systemName: 'PharmacyA' },
      { content: medWithCode('urn:med:b', 'Drug B', 'http://hl7.org/fhir/sid/ndc/9999-9999'), systemName: 'ClinicB' },
    ]);

    // Distinct codes, distinct names -> two records survive.
    expect(result.report.summary.finalRecordCount).toBe(2);
  });
});
