/**
 * `pod import`'s `patientMatch` verdict and `cascade inspect patient`.
 *
 * Importing one family member's records into another member's pod used to be
 * silent. The import report now says whether the incoming files name the pod's
 * owner (booleans, an enum and field names only), and `inspect patient` prints
 * the name and birth date each file names on stdout, so a caller holding
 * several pods can say whose records a file looks like.
 *
 * All people and documents here are synthetic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { registerInspectCommand } from '../src/commands/inspect.js';
import {
  computePatientMatch,
  namesMatch,
  birthDatesMatch,
  readIncomingPatients,
} from '../src/lib/incoming-patient.js';

// ─── Synthetic people ─────────────────────────────────────────────────────────

const OLDER = { given: 'Zelphine', family: 'Quorbel', dob: '20140309', iso: '2014-03-09' };
const YOUNGER = { given: 'Trevvor', family: 'Quorbel', dob: '20170821', iso: '2017-08-21' };

/** Every string that would make a report a PHI leak. */
const PHI_STRINGS = [
  OLDER.given, YOUNGER.given, OLDER.family,
  OLDER.dob, OLDER.iso, YOUNGER.dob, YOUNGER.iso,
];

// ─── CLI harness ──────────────────────────────────────────────────────────────

function buildProgram(): Command {
  const program = new Command();
  program
    .name('cascade')
    .exitOverride()
    .option('--verbose', 'Verbose output', false)
    .option('--json', 'Output JSON', false);
  registerPodCommand(program);
  registerInspectCommand(program);
  return program;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = buildProgram();
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.map(String).join(' '));
  });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    err.push(a.map(String).join(' '));
  });
  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      out.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'cascade', ...args]);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
    writeSpy.mockRestore();
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

// ─── Synthetic documents ──────────────────────────────────────────────────────

function ccdaFor(p: { given: string; family: string; dob: string }, docId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <realmCode code="US"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.3.88.11.32.1" extension="${docId}"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Synthetic summary</title>
  <effectiveTime value="20260101120000+0000"/>
  <recordTarget>
    <patientRole>
      <id root="2.16.840.1.113883.4.1" extension="${docId}-MRN"/>
      <patient>
        <name use="L"><given>${p.given}</given><family>${p.family}</family></name>
        <administrativeGenderCode code="F" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="${p.dob}"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component>
    <structuredBody>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.2.1"/>
          <code code="11369-6" codeSystem="2.16.840.1.113883.6.1"/>
          <title>Immunizations</title>
          <entry typeCode="DRIV">
            <substanceAdministration classCode="SBADM" moodCode="EVN" negationInd="false">
              <templateId root="2.16.840.1.113883.10.20.22.4.52"/>
              <id root="2.16.840.1.113883.3.88.11.32.1" extension="${docId}-IMM"/>
              <statusCode code="completed"/>
              <effectiveTime value="20231001"/>
              <consumable>
                <manufacturedProduct classCode="MANU">
                  <manufacturedMaterial>
                    <code code="140" displayName="Influenza, seasonal" codeSystem="2.16.840.1.113883.12.292"/>
                  </manufacturedMaterial>
                </manufacturedProduct>
              </consumable>
            </substanceAdministration>
          </entry>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>
`;
}

function xdmZip(...docs: string[]): Buffer {
  const zip = new AdmZip();
  zip.addFile('INDEX.HTM', Buffer.from('<html><body>Portal export</body></html>', 'utf-8'));
  zip.addFile('IHE_XDM/SUBSET01/METADATA.XML', Buffer.from('<Metadata/>', 'utf-8'));
  docs.forEach((d, i) => zip.addFile(`IHE_XDM/SUBSET01/DOC000${i + 1}.XML`, Buffer.from(d, 'utf-8')));
  return zip.toBuffer();
}

function fhirBundleFor(p: { given: string; family: string; iso: string }): string {
  return JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'Patient',
          id: `pat-${p.given.toLowerCase()}`,
          name: [{ use: 'official', given: [p.given], family: p.family }],
          gender: 'male',
          birthDate: p.iso,
        },
      },
      {
        resource: {
          resourceType: 'Condition',
          id: `cond-${p.given.toLowerCase()}`,
          code: { coding: [{ system: 'http://snomed.info/sct', code: '195662009', display: 'Acute viral pharyngitis' }] },
          clinicalStatus: { coding: [{ code: 'active' }] },
          recordedDate: '2025-02-02',
        },
      },
    ],
  });
}

/** An Apple-Health-style clinical record: one FHIR resource, no Patient. */
function fhirWithoutPatient(): string {
  return JSON.stringify({
    resourceType: 'Immunization',
    id: 'imm-x',
    status: 'completed',
    vaccineCode: { coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '140' }] },
    occurrenceDateTime: '2023-10-01',
  });
}

// ─── Fixture dirs ─────────────────────────────────────────────────────────────

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-patient-match-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, content: string | Buffer): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

async function importReport(pod: string, files: string[], extra: string[] = []) {
  const reportPath = path.join(tmp, `report-${Math.random().toString(36).slice(2)}.json`);
  const r = await runCli(['pod', 'import', pod, ...files, '--source-system', 'synthetic-portal', '--report', reportPath, ...extra]);
  const text = fs.readFileSync(reportPath, 'utf-8');
  return { ...r, text, report: JSON.parse(text) };
}

function expectNoPhi(s: string): void {
  for (const phi of PHI_STRINGS) expect(s, `"${phi}" leaked`).not.toContain(phi);
}

// ─── The comparison rules ─────────────────────────────────────────────────────

describe('patient comparison rules', () => {
  it('normalizes names: case, accents, punctuation and a one-sided middle name', () => {
    expect(namesMatch('Zelphine Quorbel', 'ZELPHINE  quorbel')).toBe(true);
    expect(namesMatch('Zélphine Quorbel', 'Zelphine Quorbel')).toBe(true);
    expect(namesMatch('Zelphine Ann Quorbel', 'Zelphine Quorbel')).toBe(true);
    expect(namesMatch('Zelphine', 'Zelphine Quorbel')).toBe(true);
    expect(namesMatch('Trevvor Quorbel', 'Zelphine Quorbel')).toBe(false);
    expect(namesMatch('Zelphine Quorbel', 'Zelphine Smith')).toBe(false);
  });

  it('compares birth dates exactly, at the precision both sides state', () => {
    expect(birthDatesMatch('2014-03-09', '20140309')).toBe(true);
    expect(birthDatesMatch('2014-03-09', '2014-03-10')).toBe(false);
    expect(birthDatesMatch('2014', '2014-03-09')).toBe(true);
  });

  it('is unverified when nothing is comparable', () => {
    const v = computePatientMatch({}, [{ name: 'Zelphine Quorbel', birthDate: OLDER.iso }]);
    expect(v.status).toBe('unverified');
    expect(v.comparedFields).toEqual([]);
    expect(v.pod).toEqual({ hasName: false, hasDob: false });
    expect(v.incoming).toEqual({ hasName: true, hasDob: true });
    expectNoPhi(JSON.stringify(v));
  });

  it('names the differing field for a mismatch, and only the field', () => {
    const v = computePatientMatch(
      { name: 'Zelphine Quorbel', dateOfBirth: OLDER.iso },
      [{ name: 'Zelphine Quorbel', birthDate: YOUNGER.iso }],
    );
    expect(v.status).toBe('mismatch');
    expect(v.comparedFields).toEqual(['name', 'dateOfBirth']);
    expect(v.detail).toContain('dateOfBirth');
    expect(v.detail).not.toMatch(/\bname\b/);
    expectNoPhi(JSON.stringify(v));
  });
});

// ─── pod import ───────────────────────────────────────────────────────────────

describe('pod import: patientMatch', () => {
  it('is unverified on the first import into a fresh pod', async () => {
    const pod = path.join(tmp, 'pod');
    await runCli(['pod', 'init', pod]);
    const r = await importReport(pod, [write('a.xml', ccdaFor(OLDER, 'DOC-A'))]);
    expect(r.exitCode).toBe(0);
    expect(r.report.patientMatch).toMatchObject({
      status: 'unverified',
      comparedFields: [],
      pod: { hasName: false, hasDob: false },
      incoming: { hasName: true, hasDob: true },
    });
    expectNoPhi(r.text);
  });

  it('matches the owner name a pod was created with', async () => {
    const pod = path.join(tmp, 'pod');
    await runCli(['pod', 'init', pod, '--owner-name', `${OLDER.given} ${OLDER.family}`]);
    const r = await importReport(pod, [write('a.xml', ccdaFor(OLDER, 'DOC-A'))]);
    expect(r.exitCode).toBe(0);
    expect(r.report.patientMatch).toMatchObject({
      status: 'match',
      comparedFields: ['name'],
      pod: { hasName: true, hasDob: false },
    });
    expectNoPhi(r.text);
  });

  it('flags another family member on a dry run, without changing the exit code or the pod', async () => {
    const pod = path.join(tmp, 'pod');
    await runCli(['pod', 'init', pod, '--owner-name', `${OLDER.given} ${OLDER.family}`]);
    // A first real import gives the pod a date of birth to compare too.
    const first = await importReport(pod, [write('a.xml', ccdaFor(OLDER, 'DOC-A'))]);
    expect(first.report.patientMatch.status).toBe('match');

    const before = fs.readFileSync(path.join(pod, 'clinical', 'patient-profile.ttl'), 'utf-8');
    const sibling = write('b.xml', ccdaFor(YOUNGER, 'DOC-B'));
    const dry = await importReport(pod, [sibling], ['--dry-run']);
    expect(dry.exitCode).toBe(0);
    expect(dry.report.dryRun).toBe(true);
    expect(dry.report.patientMatch).toMatchObject({
      status: 'mismatch',
      comparedFields: ['name', 'dateOfBirth'],
      pod: { hasName: true, hasDob: true },
      incoming: { hasName: true, hasDob: true },
    });
    expect(dry.report.patientMatch.detail).toContain('name, dateOfBirth');
    expectNoPhi(dry.text);
    expectNoPhi(dry.stderr);
    expect(dry.stderr).toContain('may belong to someone other');
    expect(fs.readFileSync(path.join(pod, 'clinical', 'patient-profile.ttl'), 'utf-8')).toBe(before);

    // The same file imported for real: still exit 0, still imported.
    const real = await importReport(pod, [sibling]);
    expect(real.exitCode).toBe(0);
    expect(real.report.patientMatch.status).toBe('mismatch');
    expect(real.report.totalRecordsImported).toBeGreaterThan(0);
    expectNoPhi(real.text);
  });

  it('reads a FHIR bundle and an XDM zip the same way', async () => {
    const pod = path.join(tmp, 'pod');
    await runCli(['pod', 'init', pod, '--owner-name', `${OLDER.given} ${OLDER.family}`]);
    const fhir = await importReport(pod, [write('b.json', fhirBundleFor(YOUNGER))], ['--dry-run']);
    expect(fhir.report.patientMatch).toMatchObject({ status: 'mismatch', comparedFields: ['name'] });
    expectNoPhi(fhir.text);

    const zip = await importReport(pod, [write('export.zip', xdmZip(ccdaFor(OLDER, 'DOC-Z')))], ['--dry-run']);
    expect(zip.report.patientMatch).toMatchObject({ status: 'match', comparedFields: ['name'] });
  });

  it('is unverified when the files name nobody', async () => {
    const pod = path.join(tmp, 'pod');
    await runCli(['pod', 'init', pod, '--owner-name', `${OLDER.given} ${OLDER.family}`]);
    const r = await importReport(pod, [write('imm.json', fhirWithoutPatient())], ['--dry-run']);
    expect(r.exitCode).toBe(0);
    expect(r.report.patientMatch).toMatchObject({
      status: 'unverified',
      incoming: { hasName: false, hasDob: false },
    });
  });
});

// ─── inspect patient ──────────────────────────────────────────────────────────

describe('inspect patient', () => {
  async function inspect(...paths: string[]) {
    const r = await runCli(['inspect', 'patient', ...paths]);
    return { ...r, out: JSON.parse(r.stdout) as { files: Array<Record<string, unknown>> } };
  }

  it('reads a C-CDA document', async () => {
    const f = write('a.xml', ccdaFor(OLDER, 'DOC-A'));
    const r = await inspect(f);
    expect(r.exitCode).toBe(0);
    expect(r.out.files).toEqual([
      { file: f, format: 'c-cda', incomingPatient: { name: 'Zelphine Quorbel', birthDate: OLDER.iso }, patientCount: 1 },
    ]);
  });

  it('reads an IHE XDM zip, counting distinct patients across its documents', async () => {
    const f = write('export', xdmZip(ccdaFor(OLDER, 'DOC-1'), ccdaFor(OLDER, 'DOC-2'), ccdaFor(YOUNGER, 'DOC-3')));
    const r = await inspect(f);
    expect(r.out.files).toEqual([
      { file: f, format: 'c-cda', incomingPatient: { name: 'Zelphine Quorbel', birthDate: OLDER.iso }, patientCount: 2 },
    ]);
  });

  it('reads a FHIR bundle', async () => {
    const f = write('b.json', fhirBundleFor(YOUNGER));
    const r = await inspect(f);
    expect(r.out.files).toEqual([
      { file: f, format: 'fhir-json', incomingPatient: { name: 'Trevvor Quorbel', birthDate: YOUNGER.iso }, patientCount: 1 },
    ]);
  });

  it('reports null for a file that names no patient', async () => {
    const f = write('imm.json', fhirWithoutPatient());
    const r = await inspect(f);
    expect(r.exitCode).toBe(0);
    expect(r.out.files).toEqual([{ file: f, format: 'fhir-json', incomingPatient: null, patientCount: 0 }]);
  });

  it('expands a folder and reports an Apple Health export.xml as naming nobody', async () => {
    const dir = path.join(tmp, 'apple_health_export');
    fs.mkdirSync(path.join(dir, 'clinical-records'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'export.xml'),
      '<?xml version="1.0"?><HealthData locale="en_US"><ExportDate value="2026-01-01 00:00:00 -0800"/></HealthData>',
    );
    fs.writeFileSync(path.join(dir, 'clinical-records', 'Immunization-1.json'), fhirWithoutPatient());
    const r = await inspect(dir);
    expect(r.exitCode).toBe(0);
    expect(r.out.files.length).toBeGreaterThan(0);
    for (const f of r.out.files) expect(f.incomingPatient).toBeNull();
    expect(r.out.files.some((f) => f.format === 'apple-health-export')).toBe(true);
  });

  it('reports a file it cannot read as unreadable, exit 2, never as naming nobody', async () => {
    const good = write('a.xml', ccdaFor(OLDER, 'DOC-A'));
    const bad = write('broken.json', '{ "resourceType": "Bundle", ');
    const notCcda = write('other.xml', '<html><body>not a record</body></html>');
    const r = await runCli(['inspect', 'patient', good, bad, notCcda]);
    expect(r.exitCode).toBe(2);
    const out = JSON.parse(r.stdout) as { files: Array<Record<string, unknown>> };
    expect(out.files.map((f) => f.format)).toEqual(['c-cda', 'unreadable', 'unreadable']);
    expect(out.files[1].incomingPatient).toBeNull();
  });

  it('exits 1 for a path that does not exist', async () => {
    const r = await runCli(['inspect', 'patient', path.join(tmp, 'missing.xml')]);
    expect(r.exitCode).toBe(1);
  });

  it('reads the same patients the import reads', () => {
    const bytes = Buffer.from(ccdaFor(YOUNGER, 'DOC-B'));
    expect(readIncomingPatients(bytes, 'ccda')).toEqual([{ name: 'Trevvor Quorbel', birthDate: YOUNGER.iso }]);
  });
});
