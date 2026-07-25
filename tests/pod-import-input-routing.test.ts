/**
 * `pod import` input routing and pod-internal resource reads.
 *
 * Covers two defects:
 *
 *   root 2.8 — routing was by filename suffix only, so an extension-less IHE
 *   XDM zip (what a real portal download looks like) fell through to the Turtle
 *   parser and died with `Unexpected "PK..."`. The bytes now decide when the
 *   extension is missing or unrecognized.
 *
 *   root 4.23 — every input was read as plaintext, so a bundle written to
 *   `<pod>/analysis/<id>.ttl` on an ENCRYPTED pod could not be imported back.
 *   An input that resolves inside the destination pod is now read through the
 *   pod DEK the command already holds.
 *
 * All documents here are synthetic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import {
  classifyImportInput,
  sniffImportInput,
  looksLikeZip,
  looksLikeCcdaXml,
  isPathInsidePod,
} from '../src/lib/import-input.js';
import { resolveDek, writeResource } from '../src/lib/pod-encryption.js';

const PASSPHRASE = 'input-routing-test-passphrase';

// `pod init --encrypt` + `pod import` run the real Argon2id KDF (t=3, m=64 MiB)
// several times per test, which is deliberately slow.
const TEST_TIMEOUT_MS = 60_000;

// ─── CLI harness ──────────────────────────────────────────────────────────────

function buildProgram(): Command {
  const program = new Command();
  program
    .name('cascade')
    .exitOverride()
    .option('--verbose', 'Verbose output', false)
    .option('--json', 'Output JSON', false);
  registerPodCommand(program);
  return program;
}

async function runCli(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const program = buildProgram();
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'cascade', ...args]);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: chunks.join('\n'), exitCode };
}

// ─── Synthetic documents ──────────────────────────────────────────────────────

/** A minimal but structurally valid C-CDA with one immunization entry. */
function syntheticCcdaXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <realmCode code="US"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.3.88.11.32.1" extension="ROUTING-FIXTURE-001"/>
  <code code="34133-9" displayName="Summarization of Episode Note" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
  <title>Extension-less Routing Fixture</title>
  <effectiveTime value="20260101120000+0000"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <languageCode code="en-US"/>
  <recordTarget>
    <patientRole>
      <id root="2.16.840.1.113883.4.1" extension="000-00-0000"/>
      <patient>
        <name use="L"><given>Testy</given><family>McTestface</family></name>
        <administrativeGenderCode code="F" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="19850412"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component>
    <structuredBody>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.2.1"/>
          <code code="11369-6" displayName="History of Immunization Narrative" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
          <title>Immunizations</title>
          <text>Influenza, seasonal (CVX 140) - 2023-10-01</text>
          <entry typeCode="DRIV">
            <substanceAdministration classCode="SBADM" moodCode="EVN" negationInd="false">
              <templateId root="2.16.840.1.113883.10.20.22.4.52"/>
              <id root="2.16.840.1.113883.3.88.11.32.1" extension="ROUTING-IMMUN-001"/>
              <statusCode code="completed"/>
              <effectiveTime value="20231001"/>
              <consumable>
                <manufacturedProduct classCode="MANU">
                  <templateId root="2.16.840.1.113883.10.20.22.4.54"/>
                  <manufacturedMaterial>
                    <code code="140" displayName="Influenza, seasonal, injectable, preservative free" codeSystem="2.16.840.1.113883.12.292" codeSystemName="CVX"/>
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

/**
 * An IHE-XDM-shaped zip: the C-CDA lives under a subdirectory beside an
 * INDEX.HTM, exactly like a portal "download my record" bundle.
 */
function syntheticXdmZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile('INDEX.HTM', Buffer.from('<html><body>Portal export</body></html>', 'utf-8'));
  zip.addFile('IHE_XDM/SUBSET01/DOCUMENT.XML', Buffer.from(syntheticCcdaXml(), 'utf-8'));
  return zip.toBuffer();
}

/** Synthetic FHIR bundle: a Patient plus two MedicationStatements. */
function syntheticFhirBundle(): string {
  return JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'Patient',
          id: 'pat-1',
          name: [{ given: ['Testy'], family: 'McTestface' }],
          gender: 'female',
          birthDate: '1985-04-12',
        },
      },
      {
        resource: {
          resourceType: 'MedicationStatement',
          id: 'med-1',
          status: 'active',
          medicationCodeableConcept: {
            coding: [
              {
                system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
                code: '197361',
                display: 'Lisinopril 10 MG',
              },
            ],
            text: 'Lisinopril 10 MG',
          },
          subject: { reference: 'Patient/pat-1' },
        },
      },
      {
        resource: {
          resourceType: 'MedicationStatement',
          id: 'med-2',
          status: 'active',
          medicationCodeableConcept: {
            coding: [
              {
                system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
                code: '860975',
                display: 'Metformin 500 MG',
              },
            ],
            text: 'Metformin 500 MG',
          },
          subject: { reference: 'Patient/pat-1' },
        },
      },
    ],
  });
}

/**
 * A Cascade Turtle bundle shaped like what an app writes to
 * `<pod>/analysis/<id>.ttl`: two conditions carrying AI-extracted provenance.
 */
function syntheticAnalysisBundle(): string {
  return `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<urn:uuid:11111111-1111-4111-8111-111111111111>
    a health:ConditionRecord ;
    rdfs:label "Seasonal allergic rhinitis" ;
    cascade:dataProvenance cascade:AIExtracted ;
    cascade:recordedAt "2026-01-01T00:00:00Z"^^xsd:dateTime .

<urn:uuid:22222222-2222-4222-8222-222222222222>
    a health:ConditionRecord ;
    rdfs:label "Vitamin D deficiency" ;
    cascade:dataProvenance cascade:AIExtracted ;
    cascade:recordedAt "2026-01-01T00:00:00Z"^^xsd:dateTime .
`;
}

// ─── Temp dirs ────────────────────────────────────────────────────────────────

let tmpDirs: string[] = [];
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-import-routing-'));
  tmpDirs.push(d);
  return d;
}

beforeEach(() => {
  delete process.env.CASCADE_POD_PASSPHRASE;
});

afterEach(() => {
  delete process.env.CASCADE_POD_PASSPHRASE;
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs = [];
});

// ─── Unit: byte sniffing (root 2.8) ───────────────────────────────────────────

describe('import input sniffing (root 2.8)', () => {
  it('recognizes the three ZIP signatures and nothing else', () => {
    expect(looksLikeZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe(true);
    expect(looksLikeZip(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true); // empty archive
    expect(looksLikeZip(Buffer.from([0x50, 0x4b, 0x07, 0x08]))).toBe(true); // spanned
    expect(looksLikeZip(Buffer.from([0x50, 0x4b, 0x01, 0x02]))).toBe(false); // central dir header
    expect(looksLikeZip(Buffer.from('PK', 'utf-8'))).toBe(false); // too short
    expect(looksLikeZip(Buffer.from('@prefix clinical: <x> .', 'utf-8'))).toBe(false);
  });

  it('recognizes an XML declaration and a bare ClinicalDocument root', () => {
    expect(looksLikeCcdaXml(Buffer.from('<?xml version="1.0"?><ClinicalDocument/>', 'utf-8'))).toBe(true);
    expect(looksLikeCcdaXml(Buffer.from('<ClinicalDocument xmlns="urn:hl7-org:v3"/>', 'utf-8'))).toBe(true);
    // Leading whitespace and a UTF-8 BOM must not hide the marker.
    expect(looksLikeCcdaXml(Buffer.from('\n\n  <?xml version="1.0"?>', 'utf-8'))).toBe(true);
    expect(
      looksLikeCcdaXml(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<?xml version="1.0"?>', 'utf-8')]),
      ),
    ).toBe(true);
  });

  it('does NOT treat Turtle that opens with an IRI as XML', () => {
    const turtle = Buffer.from('<https://example.org/a> <https://example.org/b> "c" .', 'utf-8');
    expect(looksLikeCcdaXml(turtle)).toBe(false);
    expect(sniffImportInput(turtle)).toBeUndefined();
  });

  it('sniffs JSON objects and arrays', () => {
    expect(sniffImportInput(Buffer.from('  {"resourceType":"Bundle"}', 'utf-8'))).toBe('fhir-json');
    expect(sniffImportInput(Buffer.from('[{"resourceType":"Patient"}]', 'utf-8'))).toBe('fhir-json');
  });
});

describe('import input classification (root 2.8)', () => {
  const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
  const xmlBytes = Buffer.from(syntheticCcdaXml(), 'utf-8');
  const jsonBytes = Buffer.from(syntheticFhirBundle(), 'utf-8');
  const turtleBytes = Buffer.from(syntheticAnalysisBundle(), 'utf-8');

  it('keeps the extension fast path for recognized names', () => {
    expect(classifyImportInput('/x/export.zip', zipBytes)).toBe('ccda');
    expect(classifyImportInput('/x/EXPORT.ZIP', zipBytes)).toBe('ccda'); // case-insensitive
    expect(classifyImportInput('/x/ccd.xml', xmlBytes)).toBe('ccda');
    expect(classifyImportInput('/x/bundle.json', jsonBytes)).toBe('fhir-json');
    expect(classifyImportInput('/x/records.ttl', turtleBytes)).toBe('turtle');
  });

  it('routes an extension-less file by its bytes, not its name', () => {
    expect(classifyImportInput('/x/1-Download', zipBytes)).toBe('ccda');
    expect(classifyImportInput('/x/1-Download', xmlBytes)).toBe('ccda');
    expect(classifyImportInput('/x/1-Download', jsonBytes)).toBe('fhir-json');
    expect(classifyImportInput('/x/1-Download', turtleBytes)).toBe('turtle');
  });

  it('routes an unrecognized extension by its bytes too', () => {
    expect(classifyImportInput('/x/download.bin', zipBytes)).toBe('ccda');
    expect(classifyImportInput('/x/download.txt', xmlBytes)).toBe('ccda');
    expect(classifyImportInput('/x/download.dat', jsonBytes)).toBe('fhir-json');
  });

  it('still falls back to Turtle when nothing is recognizable', () => {
    expect(classifyImportInput('/x/mystery', Buffer.from('nothing familiar here', 'utf-8'))).toBe('turtle');
    expect(classifyImportInput('/x/mystery', Buffer.alloc(0))).toBe('turtle');
  });

  it('does not re-route a .ttl whose content starts with an IRI', () => {
    const iriTurtle = Buffer.from('<https://example.org/a> a <https://example.org/B> .', 'utf-8');
    expect(classifyImportInput('/x/records.ttl', iriTurtle)).toBe('turtle');
  });
});

// ─── Unit: pod containment (root 4.23) ────────────────────────────────────────

describe('pod containment detection (root 4.23)', () => {
  it('says inside for a real descendant and outside for a sibling', () => {
    const root = mkTmpDir();
    const pod = path.join(root, 'pod');
    fs.mkdirSync(path.join(pod, 'analysis'), { recursive: true });
    const inside = path.join(pod, 'analysis', 'bundle.ttl');
    fs.writeFileSync(inside, 'x');

    const outside = path.join(root, 'bundle.ttl');
    fs.writeFileSync(outside, 'x');

    expect(isPathInsidePod(inside, pod)).toBe(true);
    expect(isPathInsidePod(outside, pod)).toBe(false);
  });

  it('resolves `..` rather than trusting the literal path', () => {
    const root = mkTmpDir();
    const pod = path.join(root, 'pod');
    fs.mkdirSync(path.join(pod, 'analysis'), { recursive: true });
    const outside = path.join(root, 'bundle.ttl');
    fs.writeFileSync(outside, 'x');

    // Spelled as if it were inside the pod, but `..` walks back out.
    const sneaky = path.join(pod, 'analysis', '..', '..', 'bundle.ttl');
    expect(isPathInsidePod(sneaky, pod)).toBe(false);
  });

  it('follows a symlink planted inside the pod back out to its real location', () => {
    const root = mkTmpDir();
    const pod = path.join(root, 'pod');
    fs.mkdirSync(path.join(pod, 'analysis'), { recursive: true });
    const external = path.join(root, 'external.ttl');
    fs.writeFileSync(external, 'x');

    const link = path.join(pod, 'analysis', 'link.ttl');
    fs.symlinkSync(external, link);

    // The link LOOKS pod-internal; its target is not, so it must read as external.
    expect(isPathInsidePod(link, pod)).toBe(false);
  });

  it('sees through a symlinked ancestor of the pod itself', () => {
    const root = mkTmpDir();
    const realPod = path.join(root, 'real-pod');
    fs.mkdirSync(path.join(realPod, 'analysis'), { recursive: true });
    const inside = path.join(realPod, 'analysis', 'bundle.ttl');
    fs.writeFileSync(inside, 'x');

    const alias = path.join(root, 'alias-pod');
    fs.symlinkSync(realPod, alias);

    // Pod named through the alias, file named through the real path (and vice
    // versa): both are the same directory, so both must answer "inside".
    expect(isPathInsidePod(inside, alias)).toBe(true);
    expect(isPathInsidePod(path.join(alias, 'analysis', 'bundle.ttl'), realPod)).toBe(true);
  });

  it('does not call the pod directory itself, or a missing file, inside', () => {
    const root = mkTmpDir();
    const pod = path.join(root, 'pod');
    fs.mkdirSync(pod, { recursive: true });

    expect(isPathInsidePod(pod, pod)).toBe(false);
    expect(isPathInsidePod(path.join(pod, 'nope.ttl'), pod)).toBe(false);
    expect(isPathInsidePod(path.join(pod, 'a.ttl'), path.join(root, 'no-such-pod'))).toBe(false);
  });

  it('is not fooled by a pod-name prefix on a sibling directory', () => {
    const root = mkTmpDir();
    const pod = path.join(root, 'pod');
    fs.mkdirSync(pod, { recursive: true });
    const decoy = path.join(root, 'pod-backup');
    fs.mkdirSync(decoy, { recursive: true });
    const file = path.join(decoy, 'bundle.ttl');
    fs.writeFileSync(file, 'x');

    // A naive string-prefix check would call `/root/pod-backup/...` inside `/root/pod`.
    expect(isPathInsidePod(file, pod)).toBe(false);
  });
});

// ─── Integration: extension-less inputs (root 2.8) ────────────────────────────

describe('pod import: extension-less inputs (root 2.8)', () => {
  it('imports an extension-less IHE XDM zip instead of failing in the Turtle parser', async () => {
    const root = mkTmpDir();
    const pod = path.join(root, 'pod');
    await runCli(['pod', 'init', pod]);

    // A portal capture: URL-derived name, no suffix, real zip bytes.
    const capture = path.join(root, '1-Download');
    fs.writeFileSync(capture, syntheticXdmZip());

    const imp = await runCli(['--json', 'pod', 'import', pod, capture]);
    expect(imp.exitCode).toBe(0);
    expect(imp.stdout).not.toContain('Unexpected "PK');

    const report = JSON.parse(imp.stdout);
    expect(report.totalRecordsImported).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(pod, 'clinical', 'immunizations.ttl'))).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('imports an extension-less C-CDA XML document', async () => {
    const root = mkTmpDir();
    const pod = path.join(root, 'pod');
    await runCli(['pod', 'init', pod]);

    const capture = path.join(root, 'ccda-no-extension');
    fs.writeFileSync(capture, syntheticCcdaXml(), 'utf-8');

    const imp = await runCli(['--json', 'pod', 'import', pod, capture]);
    expect(imp.exitCode).toBe(0);
    const report = JSON.parse(imp.stdout);
    expect(report.totalRecordsImported).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it('imports an extension-less FHIR bundle (unchanged behavior, guarded)', async () => {
    const root = mkTmpDir();
    const pod = path.join(root, 'pod');
    await runCli(['pod', 'init', pod]);

    const capture = path.join(root, 'fhir-no-extension');
    fs.writeFileSync(capture, syntheticFhirBundle(), 'utf-8');

    const imp = await runCli(['--json', 'pod', 'import', pod, capture]);
    expect(imp.exitCode).toBe(0);

    const q = await runCli(['--json', 'pod', 'query', pod, '--medications']);
    expect(JSON.parse(q.stdout).dataTypes.medications.count).toBe(2);
  }, TEST_TIMEOUT_MS);

  it('still imports a .zip by its extension (fast path unchanged)', async () => {
    const root = mkTmpDir();
    const pod = path.join(root, 'pod');
    await runCli(['pod', 'init', pod]);

    const zipPath = path.join(root, 'export.zip');
    fs.writeFileSync(zipPath, syntheticXdmZip());

    const imp = await runCli(['--json', 'pod', 'import', pod, zipPath]);
    expect(imp.exitCode).toBe(0);
    expect(JSON.parse(imp.stdout).totalRecordsImported).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);
});

// ─── Integration: pod-internal encrypted input (root 4.23) ────────────────────

describe('pod import: pod-internal resources on an encrypted pod (root 4.23)', () => {
  it('round-trips an encrypted bundle written into <pod>/analysis and imported back', async () => {
    process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
    const root = mkTmpDir();
    const pod = path.join(root, 'pod');
    const init = await runCli(['pod', 'init', pod, '--encrypt']);
    expect(init.exitCode).toBe(0);

    // Write the bundle the way an app does: sealed with the pod DEK, inside the pod.
    const dek = resolveDek(pod, PASSPHRASE);
    const analysisDir = path.join(pod, 'analysis');
    fs.mkdirSync(analysisDir, { recursive: true });
    const bundlePath = path.join(analysisDir, 'run-0001.ttl');
    writeResource(bundlePath, syntheticAnalysisBundle(), dek);

    // It really is ciphertext on disk.
    const onDisk = fs.readFileSync(bundlePath).toString('utf-8');
    expect(onDisk).not.toContain('@prefix');
    expect(onDisk).not.toContain('Vitamin D deficiency');

    // Import it by its POD-INTERNAL path. Before the fix this read ciphertext as
    // plaintext and failed to parse.
    const imp = await runCli(['--json', 'pod', 'import', pod, bundlePath]);
    expect(imp.exitCode).toBe(0);
    const report = JSON.parse(imp.stdout);
    expect(report.totalRecordsImported).toBe(2);

    // The records landed in the pod and query reads them back.
    const q = await runCli(['--json', 'pod', 'query', pod, '--conditions']);
    expect(q.exitCode).toBe(0);
    expect(JSON.parse(q.stdout).dataTypes.conditions.count).toBe(2);

    // And the destination file is still sealed.
    const conditionsBytes = fs
      .readFileSync(path.join(pod, 'clinical', 'conditions.ttl'))
      .toString('utf-8');
    expect(conditionsBytes).not.toContain('@prefix');
    expect(conditionsBytes).not.toContain('Vitamin D deficiency');
  }, TEST_TIMEOUT_MS);

  it('still reads a genuinely EXTERNAL file as plaintext on an encrypted pod', async () => {
    process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
    const root = mkTmpDir();
    const pod = path.join(root, 'pod');
    await runCli(['pod', 'init', pod, '--encrypt']);

    // Sits next to the pod, not inside it.
    const external = path.join(root, 'bundle.json');
    fs.writeFileSync(external, syntheticFhirBundle(), 'utf-8');

    const imp = await runCli(['pod', 'import', pod, external]);
    expect(imp.exitCode).toBe(0);

    const q = await runCli(['--json', 'pod', 'query', pod, '--medications']);
    expect(JSON.parse(q.stdout).dataTypes.medications.count).toBe(2);
  }, TEST_TIMEOUT_MS);

  it('imports a pod-internal file that is still PLAINTEXT on an encrypted pod', async () => {
    // `pod encrypt` seals only some containers today (root 4.25), so a pod can
    // hold a plaintext analysis bundle. It must not become unimportable.
    process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
    const root = mkTmpDir();
    const pod = path.join(root, 'pod');
    await runCli(['pod', 'init', pod, '--encrypt']);

    const analysisDir = path.join(pod, 'analysis');
    fs.mkdirSync(analysisDir, { recursive: true });
    const bundlePath = path.join(analysisDir, 'legacy-plaintext.ttl');
    fs.writeFileSync(bundlePath, syntheticAnalysisBundle(), 'utf-8');

    const imp = await runCli(['--json', 'pod', 'import', pod, bundlePath]);
    expect(imp.exitCode).toBe(0);
    expect(JSON.parse(imp.stdout).totalRecordsImported).toBe(2);
  }, TEST_TIMEOUT_MS);

  it('imports a pod-internal bundle on a PLAINTEXT pod (no DEK, no change)', async () => {
    const root = mkTmpDir();
    const pod = path.join(root, 'pod');
    await runCli(['pod', 'init', pod]);

    const analysisDir = path.join(pod, 'analysis');
    fs.mkdirSync(analysisDir, { recursive: true });
    const bundlePath = path.join(analysisDir, 'run-0001.ttl');
    fs.writeFileSync(bundlePath, syntheticAnalysisBundle(), 'utf-8');

    const imp = await runCli(['--json', 'pod', 'import', pod, bundlePath]);
    expect(imp.exitCode).toBe(0);
    expect(JSON.parse(imp.stdout).totalRecordsImported).toBe(2);
  }, TEST_TIMEOUT_MS);
});
