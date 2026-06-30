/**
 * Phase 2 (medication-reconciliation port plan): the dose/frequency/status
 * false-merge fix.
 *
 * Before this, `normalizeMedName` stripped the dose before comparison, so
 * "Lisinopril 10 mg" and "Lisinopril 20 mg" normalized to the same string and
 * merged as a duplicate with NO conflict surfaced — the exact conflict the
 * Workbench Reconcile tab exists for, swallowed before it reached the tab.
 *
 * These tests prove S1's shared normalizer end to end: a matched pair that
 * disagrees on dose, frequency, or active/stopped status is classified as a
 * conflict and reaches the unresolved-conflict report (which the pod-import
 * command writes to settings/pending-conflicts.ttl), while benign differences
 * (spacing, one-sided fill-in) do NOT create a conflict.
 */

import { describe, it, expect } from 'vitest';
import { runReconciliation } from '../src/lib/reconciler.js';

const PREFIXES = `
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
`;

const RX = '<https://ns.cascadeprotocol.org/rxnorm/29046>'; // lisinopril

/** Build a single clinical:Medication turtle record. */
function med(
  uri: string,
  fields: { drugName?: string; dosage?: string; frequency?: string; status?: string; rxNorm?: boolean },
): string {
  const lines = [`<${uri}> a clinical:Medication ;`];
  if (fields.rxNorm !== false) lines.push(`  clinical:rxNormCode ${RX} ;`);
  if (fields.drugName) lines.push(`  clinical:drugName "${fields.drugName}" ;`);
  if (fields.dosage) lines.push(`  clinical:dosage "${fields.dosage}" ;`);
  if (fields.frequency) lines.push(`  clinical:frequency "${fields.frequency}" ;`);
  if (fields.status) lines.push(`  clinical:status "${fields.status}" ;`);
  // Replace the trailing " ;" of the last property line with " ."
  const body = lines.join('\n').replace(/ ;$/, ' .');
  return `${PREFIXES}\n${body}\n`;
}

describe('medication dose/frequency/status conflict classification', () => {
  it('surfaces a dose disagreement (10 mg vs 20 mg) as an unresolved conflict', async () => {
    const result = await runReconciliation([
      { content: med('urn:med:a', { drugName: 'Lisinopril 10 mg', dosage: '10 mg', status: 'active' }), systemName: 'PharmacyA' },
      { content: med('urn:med:b', { drugName: 'Lisinopril 20 mg', dosage: '20 mg', status: 'active' }), systemName: 'ClinicB' },
    ]);

    expect(result.report.summary.conflictsUnresolved).toBe(1);
    expect(result.report.summary.exactDuplicatesRemoved).toBe(0);
    expect(result.report.unresolvedConflicts).toHaveLength(1);
    expect((result.report.unresolvedConflicts[0] as { recordType: string }).recordType).toBe('clinical:Medication');

    // The conflict, and both diverging doses, are annotated on the merged record
    // (this is what pod-import serializes into pending-conflicts.ttl + the pod).
    expect(result.turtle).toContain('unresolved-conflict');
    expect(result.turtle).toContain('conflictField');
    expect(result.turtle).toContain('10 mg');
    expect(result.turtle).toContain('20 mg');
  });

  it('surfaces an active-vs-stopped status divergence as an unresolved conflict', async () => {
    const result = await runReconciliation([
      { content: med('urn:med:a', { drugName: 'Lisinopril', dosage: '10 mg', status: 'active' }), systemName: 'PharmacyA' },
      { content: med('urn:med:b', { drugName: 'Lisinopril', dosage: '10 mg', status: 'stopped' }), systemName: 'ClinicB' },
    ]);

    expect(result.report.summary.conflictsUnresolved).toBe(1);
    expect(result.report.summary.exactDuplicatesRemoved).toBe(0);
    expect((result.report.unresolvedConflicts[0] as { recordType: string }).recordType).toBe('clinical:Medication');
  });

  it('surfaces a frequency disagreement (once daily vs twice daily) as an unresolved conflict', async () => {
    const result = await runReconciliation([
      { content: med('urn:med:a', { drugName: 'Lisinopril', dosage: '10 mg', frequency: 'once daily', status: 'active' }), systemName: 'PharmacyA' },
      { content: med('urn:med:b', { drugName: 'Lisinopril', dosage: '10 mg', frequency: 'twice daily', status: 'active' }), systemName: 'ClinicB' },
    ]);

    expect(result.report.summary.conflictsUnresolved).toBe(1);
  });

  it('does NOT conflict on benign dose-spacing differences (10 mg vs 10mg)', async () => {
    const result = await runReconciliation([
      { content: med('urn:med:a', { drugName: 'Lisinopril', dosage: '10 mg', status: 'active' }), systemName: 'PharmacyA' },
      { content: med('urn:med:b', { drugName: 'Lisinopril', dosage: '10mg', status: 'active' }), systemName: 'ClinicB' },
    ]);

    expect(result.report.summary.conflictsUnresolved).toBe(0);
    // Identical after normalization -> collapses as an exact duplicate.
    expect(result.report.summary.exactDuplicatesRemoved).toBe(1);
  });

  it('treats a one-sided dose (present on one record only) as a fill-in merge, not a conflict', async () => {
    const result = await runReconciliation([
      { content: med('urn:med:a', { drugName: 'Lisinopril', dosage: '10 mg', status: 'active' }), systemName: 'PharmacyA' },
      { content: med('urn:med:b', { drugName: 'Lisinopril', status: 'active' }), systemName: 'ClinicB' },
    ]);

    expect(result.report.summary.conflictsUnresolved).toBe(0);
    expect(result.report.summary.nearDuplicatesMerged).toBe(1);
    // The merged record keeps the one recorded dose (fill-in).
    expect(result.turtle).toContain('10 mg');
  });
});
