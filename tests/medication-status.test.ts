/**
 * The medication status lifecycle: one table, one classifier, every consumer.
 *
 * The table is cascade-knowledge's medication-status-lifecycle and
 * medication-status-synonym families, vendored verbatim in
 * src/knowledge/medication-status.snapshot.json. These tests read the vendored
 * rows THEMSELVES (not through the classifier's own tables) and assert the
 * classifier answers what the rows say, so a classifier that drifted from the
 * data, or data that lost a row, goes red here.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  classifyMedicationStatus,
  medicationStatusTableDigests,
} from '../src/lib/medication-status.js';
import { runReconciliation } from '../src/lib/reconciler.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = JSON.parse(
  readFileSync(join(ROOT, 'src', 'knowledge', 'medication-status.snapshot.json'), 'utf8'),
) as { families: Record<string, { sha256: string; rows: number; lines: string[] }> };

interface Row {
  subject: { system: string; code?: string; display: string };
  predicate: string;
  object: { system: string; code?: string; display: string };
}
const rows = (f: string): Row[] => snapshot.families[f].lines.map((l) => JSON.parse(l) as Row);
const lifecycleRows = rows('medication-status-lifecycle');
const synonymRows = rows('medication-status-synonym');
const MED_SYSTEMS = ['FHIR-MEDICATIONREQUEST-STATUS', 'FHIR-MEDICATIONSTATEMENT-STATUS'];
const tableClass = new Map<string, string>();
for (const r of lifecycleRows) if (MED_SYSTEMS.includes(r.subject.system)) tableClass.set(r.subject.code!, r.object.code!);

/**
 * CROSS-REPOSITORY PIN. The per-family sha256 of the table as published by
 * cascade-knowledge. The desktop app's bundle carries the same two literals in
 * its own test, so both consumers provably read the same bytes. A re-sync that
 * changes the table changes these in the same commit, in both repositories.
 */
const PINNED_DIGESTS = {
  'medication-status-lifecycle': 'f8870fea5e109e5fd694e972cb795f6a03a47eeca54c68770c2d16d1c3bce92b',
  'medication-status-synonym': '8cee42c8517c58675fb166de0aecc8fe56312e6bf2f9efa3688023ad28a411db',
};

/**
 * The spec's medication status value set, read from the vendored clinical.ttl.
 * There is no sh:in on clinical:MedicationShape's clinical:status; the
 * vocabulary instead documents the INTENDED set (FHIR R4 MedicationRequest.status)
 * in the clinical:status comment. Parsed here rather than retyped, so a spec
 * change to that set reaches this test on the next shapes sync.
 */
function specIntendedMedicationStatuses(): string[] {
  const ttl = readFileSync(join(ROOT, 'src', 'shapes', 'clinical.ttl'), 'utf8');
  const m = ttl.match(/clinical:Medication\s+MedicationRequest\.status\s+([^\n]+)\n\s+([^\n]+)/);
  if (!m) throw new Error('clinical.ttl no longer documents the clinical:Medication status value set; update this test');
  const codes = `${m[1]} ${m[2]}`.split('|').map((s) => s.trim()).filter(Boolean);
  if (codes.length < 5) throw new Error(`parsed only ${codes.length} codes from clinical.ttl: ${codes.join(', ')}`);
  return codes;
}

describe('medication status table (vendored from cascade-knowledge)', () => {
  it('the vendored lines hash to the pinned cross-repository digests', () => {
    for (const [family, digest] of Object.entries(PINNED_DIGESTS)) {
      const bytes = snapshot.families[family].lines.join('\n') + '\n';
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
      expect(snapshot.families[family].sha256).toBe(digest);
    }
    expect(medicationStatusTableDigests()).toEqual(PINNED_DIGESTS);
  });

  it('every status value in the spec set has a row, and the classifier gives the row\'s class', () => {
    const intended = specIntendedMedicationStatuses();
    expect(intended).toEqual(['active', 'on-hold', 'cancelled', 'completed', 'entered-in-error', 'stopped', 'draft', 'unknown']);
    for (const code of intended) {
      expect(tableClass.has(code), code).toBe(true);
      expect(classifyMedicationStatus(code), code).toEqual({ lifecycle: tableClass.get(code), matchedBy: 'code', code });
    }
  });

  it('every FHIR status code in the table classifies to its row, in any case or punctuation', () => {
    expect(tableClass.size).toBe(10);
    for (const [code, cls] of tableClass) {
      expect(classifyMedicationStatus(code).lifecycle, code).toBe(cls);
      expect(classifyMedicationStatus(` ${code.toUpperCase().replace(/-/g, '_')} `).lifecycle, code).toBe(cls);
    }
  });

  it('an absent or blank status is the table\'s absent row (unknown), never active', () => {
    const absent = lifecycleRows.find((r) => r.subject.system === 'FHIR-DATA-ABSENT-REASON')!;
    expect(absent.object.code).toBe('unknown');
    for (const raw of [undefined, null, '', '   ', '--']) {
      expect(classifyMedicationStatus(raw)).toEqual({ lifecycle: 'unknown', matchedBy: 'absent' });
    }
  });

  it('every synonym classifies to its target code\'s class', () => {
    for (const r of synonymRows) {
      const got = classifyMedicationStatus(r.subject.display);
      expect(got.lifecycle, `${r.predicate} "${r.subject.display}"`).toBe(tableClass.get(r.object.code!));
    }
  });

  it('a phrase that names both stopping and taking is stopped (conservative fragment precedence)', () => {
    expect(classifyMedicationStatus('no longer taking')).toMatchObject({ lifecycle: 'stopped', matchedBy: 'fragment' });
    expect(classifyMedicationStatus('Discontinued by patient')).toMatchObject({ lifecycle: 'stopped', matchedBy: 'fragment' });
    expect(classifyMedicationStatus('currently taking')).toMatchObject({ lifecycle: 'active', matchedBy: 'fragment' });
  });

  it('an unrecognized status is unknown and says so', () => {
    expect(classifyMedicationStatus('as needed')).toEqual({ lifecycle: 'unknown', matchedBy: 'unmatched' });
  });
});

// ---------------------------------------------------------------------------
// The reconciler's status split reads the table.
// ---------------------------------------------------------------------------

const PREFIXES = `
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
`;
function med(uri: string, status?: string): string {
  const lines = [
    `<${uri}> a clinical:Medication ;`,
    '  clinical:rxNormCode <https://ns.cascadeprotocol.org/rxnorm/29046> ;',
    '  clinical:drugName "Lisinopril" ;',
    '  clinical:dosage "10 mg" ;',
  ];
  if (status) lines.push(`  clinical:status "${status}" ;`);
  return `${PREFIXES}\n${lines.join('\n').replace(/ ;$/, ' .')}\n`;
}
async function conflicts(a: string | undefined, b: string | undefined): Promise<number> {
  const result = await runReconciliation([
    { content: med('urn:med:a', a), systemName: 'PharmacyA' },
    { content: med('urn:med:b', b), systemName: 'ClinicB' },
  ]);
  return result.report.summary.conflictsUnresolved;
}

describe('reconciler medication status split', () => {
  it('not-taken vs active is a status conflict (it was read as active before the shared table)', async () => {
    expect(await conflicts('active', 'not-taken')).toBe(1);
  });

  it('an absent status vs stopped is still a conflict: absence is not a statement that it ended', async () => {
    expect(await conflicts(undefined, 'stopped')).toBe(1);
  });

  it('an absent status vs active is not a conflict: neither side says it ended', async () => {
    expect(await conflicts(undefined, 'active')).toBe(0);
  });

  it('on-hold vs active is not a status conflict (on-hold is unknown, not ended)', async () => {
    expect(await conflicts('on-hold', 'active')).toBe(0);
  });

  it('a legacy "discontinued" vs active is a conflict, through the synonym table', async () => {
    expect(await conflicts('discontinued', 'active')).toBe(1);
  });
});
