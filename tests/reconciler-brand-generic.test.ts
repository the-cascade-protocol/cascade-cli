/**
 * Phase 3 (S2): brand-to-generic canonicalization in reconciliation.
 *
 * Before this, "Zyrtec" and "cetirizine" never matched without a shared RxNorm
 * code, so a brand record and its generic survived as two records. The bundled
 * Cascade terminology asset (default-on) now resolves the brand to its generic
 * during name normalization, so they dedupe. Passing
 * identityTerminologyResolver restores the asset-free behaviour.
 */

import { describe, it, expect } from 'vitest';
import { runReconciliation } from '../src/lib/reconciler.js';
import { identityTerminologyResolver } from '../src/lib/terminology.js';

const PREFIXES = `
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
`;

/** A medication record with only a name (no code), so matching must use the name. */
function medByName(uri: string, drugName: string): string {
  return `${PREFIXES}
<${uri}> a clinical:Medication ;
  clinical:drugName "${drugName}" ;
  clinical:status "active" .
`;
}

describe('brand-to-generic reconciliation', () => {
  it('merges a brand and its generic (no shared code) via the bundled asset', async () => {
    const result = await runReconciliation([
      { content: medByName('urn:med:brand', 'Zyrtec 10 mg'), systemName: 'PharmacyA' },
      { content: medByName('urn:med:generic', 'cetirizine'), systemName: 'ClinicB' },
    ]);
    // Both collapse to one record, matched on the shared generic name.
    expect(result.report.summary.totalInputRecords).toBe(2);
    expect(result.report.summary.finalRecordCount).toBe(1);
    const t = result.report.transformations[0] as { matchedOn?: string } | undefined;
    expect(t?.matchedOn).toContain('cetirizine');
  });

  it('does NOT merge them when the resolver is disabled (asset-free baseline)', async () => {
    const result = await runReconciliation(
      [
        { content: medByName('urn:med:brand', 'Zyrtec 10 mg'), systemName: 'PharmacyA' },
        { content: medByName('urn:med:generic', 'cetirizine'), systemName: 'ClinicB' },
      ],
      { terminologyResolver: identityTerminologyResolver },
    );
    // "zyrtec" vs "cetirizine" share no token and no code -> two records.
    expect(result.report.summary.finalRecordCount).toBe(2);
  });
});
