/**
 * What honouring `resource.id` for Conditions, allergies, immunizations and
 * patients does to a real pod.
 *
 * The converter-level cases live in `clinical-identity.test.ts`. This file
 * answers the two questions a unit test cannot:
 *
 *   1. Does the fix actually stop the merge on the import path a user runs?
 *   2. Does it stop MERGING WHAT SHOULD MERGE? A change that split every
 *      re-import would be worse than the defect it replaced, because the pod
 *      would grow forever and never say so.
 *
 * THE MEASUREMENT THAT MOTIVATED THIS FILE
 * ----------------------------------------
 * Importing one person's records from two EHRs into one pod, against
 * `origin/main`, raises an UNRESOLVED IDENTITY-COLLISION CONFLICT on
 * `cascade:PatientProfile` and exits `pod conflicts` with 1. The two Patient
 * resources carry different server ids and different `Patient/…` references,
 * and the old key looked at neither — only at {birthDate, gender, family name,
 * first given name} — so two records the sources had deliberately identified
 * separately landed on one IRI, and the reconciler's collision split (which is
 * working exactly as designed) had to raise the question.
 *
 * That is the defect making work for a person: a conflict manufactured by the
 * identity layer, about two records that were never ambiguous. After the fix
 * the conflict does not arise, and the merge — which is genuinely wanted here,
 * since it IS one person — happens in the reconciler, where it is counted,
 * attributed to its sources, and reversible.
 *
 * All fixtures are synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolve } from 'node:path';

const CLI_PATH = resolve(__dirname, '../dist/index.js');
const HAVE_DIST = fs.existsSync(CLI_PATH);

function cli(args: string[]): string {
  return execFileSync('node', [CLI_PATH, ...args], { encoding: 'utf-8', timeout: 120000 });
}

/** Run a verb that is allowed to exit non-zero, and report the exit status. */
function cliStatus(args: string[]): { status: number; stdout: string } {
  try {
    return { status: 0, stdout: cli(args) };
  } catch (e: any) {
    return { status: e.status ?? -1, stdout: String(e.stdout ?? '') };
  }
}

function workspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function newPod(dir: string, name: string): string {
  const podDir = path.join(dir, name);
  cli(['pod', 'init', podDir]);
  return podDir;
}

/** `{bucket: count}` for every data type the pod holds. */
function counts(podDir: string): Record<string, number> {
  const parsed = JSON.parse(cli(['pod', 'query', podDir, '--all', '--json'])) as {
    dataTypes: Record<string, { count: number }>;
  };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed.dataTypes)) out[k] = v.count;
  return out;
}

/**
 * One person's records as ONE EHR exports them. `tag` distinguishes the
 * server-assigned identifiers and the patient reference, exactly as two
 * different systems would.
 */
function bundleFor(tag: string): string {
  const patientId = `${tag}-pat-1`;
  return JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'Patient',
          id: patientId,
          name: [{ family: 'Rivera', given: ['Alex'] }],
          gender: 'female',
          birthDate: '1985-03-15',
        },
      },
      {
        resource: {
          resourceType: 'Condition',
          id: `${tag}-cond-1`,
          subject: { reference: `Patient/${patientId}` },
          code: {
            coding: [{ system: 'http://snomed.info/sct', code: '38341003', display: 'Essential hypertension' }],
            text: 'Essential hypertension',
          },
          onsetDateTime: '2021-04-02',
        },
      },
      {
        resource: {
          resourceType: 'AllergyIntolerance',
          id: `${tag}-alg-1`,
          patient: { reference: `Patient/${patientId}` },
          code: {
            coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '7980', display: 'Penicillin G' }],
            text: 'Penicillin G',
          },
          criticality: 'high',
        },
      },
      {
        resource: {
          resourceType: 'Immunization',
          id: `${tag}-imm-1`,
          status: 'completed',
          patient: { reference: `Patient/${patientId}` },
          vaccineCode: {
            coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '141', display: 'Influenza, seasonal' }],
            text: 'Influenza, seasonal',
          },
          occurrenceDateTime: '2025-10-15',
        },
      },
    ],
  }, null, 2);
}

/**
 * Two documents from ONE system: one patient, and the same clinical facts
 * carrying DIFFERENT record identifiers — plus a real disagreement, because the
 * second document says the hypertension was later refuted.
 */
function documentFrom(docTag: string, clinicalStatus: string, verificationStatus: string): string {
  return JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'Condition',
        id: `${docTag}-cond`,
        subject: { reference: 'Patient/one-person' },
        code: {
          coding: [{ system: 'http://snomed.info/sct', code: '38341003', display: 'Essential hypertension' }],
          text: 'Essential hypertension',
        },
        onsetDateTime: '2021-04-02',
        clinicalStatus: { coding: [{ code: clinicalStatus }] },
        verificationStatus: { coding: [{ code: verificationStatus }] },
      },
    }],
  }, null, 2);
}

describe.skipIf(!HAVE_DIST)('pod import: clinical record identity', () => {
  it('one person from two EHRs no longer manufactures an identity-collision conflict', () => {
    // Against origin/main this pod ends with 1 unresolved conflict and
    // `pod conflicts` exits 1: the two Patient resources, distinctly identified
    // by their own servers, were minted onto ONE IRI and the collision split had
    // to ask a person about it.
    const ws = workspace('cascade-clin-e2e-a-');
    try {
      const a = path.join(ws, 'epic.json');
      const b = path.join(ws, 'cerner.json');
      fs.writeFileSync(a, bundleFor('epic'), 'utf8');
      fs.writeFileSync(b, bundleFor('cerner'), 'utf8');

      const pod = newPod(ws, 'pod');
      cli(['pod', 'import', pod, a]);
      cli(['pod', 'import', pod, b]);

      const conflicts = cliStatus(['pod', 'conflicts', pod]);
      expect(
        conflicts.status,
        `pod conflicts raised a question the identity layer invented:\n${conflicts.stdout}`,
      ).toBe(0);
      expect(conflicts.stdout).not.toMatch(/identity-collision/);

      // And the pod holds ONE of each: the merge still happens, in the
      // reconciler, which matches the two profiles on date of birth plus sex.
      // Against origin/main this line reads `'patient-profile': 2` — the
      // collision split left two — while the three clinical types merged, so
      // the profile is the record this assertion is really about.
      expect(counts(pod)).toMatchObject({
        'patient-profile': 1, conditions: 1, allergies: 1, immunizations: 1,
      });
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('explicitly labelled sources reconcile to one record each, patient profile included', () => {
    // The same claim with `--source-system` given by hand rather than derived
    // from the file name, so the test does not rest on that derivation.
    const ws = workspace('cascade-clin-e2e-b-');
    try {
      const a = path.join(ws, 'epic.json');
      const b = path.join(ws, 'cerner.json');
      fs.writeFileSync(a, bundleFor('epic'), 'utf8');
      fs.writeFileSync(b, bundleFor('cerner'), 'utf8');

      const pod = newPod(ws, 'pod');
      cli(['pod', 'import', pod, a, '--source-system', 'epic']);
      cli(['pod', 'import', pod, b, '--source-system', 'cerner']);

      expect(counts(pod)).toMatchObject({
        'patient-profile': 1, conditions: 1, allergies: 1, immunizations: 1,
      });
      expect(cliStatus(['pod', 'conflicts', pod]).status).toBe(0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('two documents that disagree raise a question about the RECORDS, not about a hash', () => {
    // The scenario the original "these are the same clinical fact" reasoning
    // was wrong about. Patient, code and onset agree; one document says the
    // problem is ACTIVE and CONFIRMED and the other says RESOLVED and REFUTED,
    // and each carries its own record id.
    //
    // Against origin/main this pod ends with a conflict whose id begins
    // `identity-collision:` — the two records were minted onto one IRI and the
    // question put to the user is about the IRI. The clinical disagreement was
    // never classified, because the pair never reached the matcher.
    //
    // With the ids honoured, the pair reaches the matcher, is merged there on
    // the SNOMED code, and the conflict raised is the CLINICAL one: same
    // problem, two irreconcilable statuses. Same number of questions, but this
    // one is answerable from the medicine rather than from the hash.
    const ws = workspace('cascade-clin-e2e-c-');
    try {
      const first = path.join(ws, 'doc-1.json');
      const second = path.join(ws, 'doc-2.json');
      fs.writeFileSync(first, documentFrom('doc1', 'active', 'confirmed'), 'utf8');
      fs.writeFileSync(second, documentFrom('doc2', 'resolved', 'refuted'), 'utf8');

      const pod = newPod(ws, 'pod');
      cli(['pod', 'import', pod, first]);
      cli(['pod', 'import', pod, second]);

      const conflicts = cliStatus(['pod', 'conflicts', pod]);
      expect(conflicts.status, 'the disagreement must still be raised').toBe(1);
      expect(
        conflicts.stdout,
        `the conflict is still about the identity layer rather than the records:\n${conflicts.stdout}`,
      ).not.toMatch(/identity-collision/);
      expect(conflicts.stdout).toMatch(/snomed:38341003/);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('STABILITY PIN: a true re-import is still one record, not two', () => {
    // Passes against origin/main too, and is the row that separates a fix from
    // a blunt split. Byte-identical input twice must leave the pod exactly as
    // it was.
    const ws = workspace('cascade-clin-e2e-d-');
    try {
      const file = path.join(ws, 'epic.json');
      fs.writeFileSync(file, bundleFor('epic'), 'utf8');

      const pod = newPod(ws, 'pod');
      cli(['pod', 'import', pod, file]);
      const afterFirst = counts(pod);
      cli(['pod', 'import', pod, file]);
      const afterSecond = counts(pod);

      expect(afterFirst).toMatchObject({
        'patient-profile': 1, conditions: 1, allergies: 1, immunizations: 1,
      });
      expect(afterSecond, 'a re-import duplicated records').toEqual(afterFirst);
      expect(cliStatus(['pod', 'conflicts', pod]).status).toBe(0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('STABILITY PIN: a third import of the same file still adds nothing', () => {
    // Guards the mirror-image failure specifically: an identity that moved on
    // each sync would show up as unbounded growth, and one extra import is
    // enough to see it.
    const ws = workspace('cascade-clin-e2e-e-');
    try {
      const file = path.join(ws, 'epic.json');
      fs.writeFileSync(file, bundleFor('epic'), 'utf8');

      const pod = newPod(ws, 'pod');
      cli(['pod', 'import', pod, file]);
      cli(['pod', 'import', pod, file]);
      const before = counts(pod);
      cli(['pod', 'import', pod, file]);
      expect(counts(pod)).toEqual(before);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
