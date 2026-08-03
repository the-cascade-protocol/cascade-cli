/**
 * Identity must survive the process, and the working directory.
 *
 * A determinism test that mints twice inside one process proves less than it
 * appears to. Both calls share a warm module cache, a single module-level
 * `Math.random` seed, any memoization a converter happens to hold, and one
 * `process.cwd()`. A defect that keys on ANY of those is invisible to it.
 *
 * That is not hypothetical here. The previous defect in this family (the VCF
 * `SequencingRun` IRI, root 3.7) was path-dependent, and it stayed invisible for
 * months for exactly this reason: everything ran from one directory, so the
 * oracle reproduced and the suite was green. It only surfaced when CI ran from
 * a different absolute path.
 *
 * So these cases spawn a SEPARATE `node` process per measurement, from a
 * DIFFERENT working directory, and compare the IRIs across them. The importers
 * are exercised through `dist/`, i.e. the built artifact an npm consumer
 * actually installs, rather than through the TypeScript sources.
 *
 * They are skipped when `dist/` is absent, because `npm test` without a prior
 * `npm run build` cannot honestly make this claim.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(REPO, 'dist');
const HAVE_DIST = fs.existsSync(path.join(DIST, 'lib', 'identity.js'));

/**
 * A self-contained script run in a fresh process. It imports the BUILT
 * converters by absolute file URL, so it works from any cwd, and prints the
 * minted IRIs as JSON on stdout.
 */
const SCRIPT = `
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';

const dist = process.env.CASCADE_DIST;
const load = (p) => import(pathToFileURL(path.join(dist, p)).href);

const { convertFhirResourceToQuads } = await load('lib/fhir-converter/fhir-to-cascade.js');
const { convertGenomicsBundle } = await load('lib/fhir-genomics-converter/index.js');
const { convertPhenopacket } = await load('lib/phenopacket-converter/index.js');
const { convertCcda } = await load('lib/ccda-converter/index.js');

const payload = JSON.parse(process.env.CASCADE_PAYLOAD);
const ctx = {
  inputPath: payload.inputPath,
  outputSerialization: 'turtle',
  importedAt: payload.importedAt,
  options: {},
};

const out = {};

const fhir = convertFhirResourceToQuads(payload.fhir);
out.fhir = fhir._quads[0].subject.value;

const genomics = await convertGenomicsBundle(payload.genomics, ctx);
out.genomics = genomics.records.map((r) => r.iri);

const pheno = await convertPhenopacket(payload.phenopacket, ctx);
out.phenopacket = pheno.records.map((r) => r.iri);

const ccda = await convertCcda(payload.ccda, { importedAt: payload.importedAt });
out.ccda = [...new Set((ccda.output ?? '').match(/urn:uuid:[0-9a-f-]{36}/g) ?? [])].sort();

// cwd is reported so a failure shows which directory produced which answer.
out._cwd = process.cwd();
process.stdout.write(JSON.stringify(out));
`;

/** The same id-less inputs the in-process suite uses. */
const FHIR = {
  resourceType: 'Observation',
  status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] },
  subject: { reference: 'Patient/synthetic-1' },
  effectiveDateTime: '2026-01-15T09:30:00Z',
  valueQuantity: { value: 72, unit: '/min' },
};

const GENOMICS = {
  resourceType: 'Bundle',
  type: 'collection',
  entry: [
    {
      resource: {
        resourceType: 'Observation',
        meta: { profile: ['http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/variant'] },
        status: 'final',
        code: { coding: [{ system: 'http://loinc.org', code: '69548-6' }] },
        valueCodeableConcept: { coding: [{ system: 'http://loinc.org', code: 'LA9633-4', display: 'Present' }] },
        component: [
          {
            code: { coding: [{ system: 'http://loinc.org', code: '48004-6' }] },
            valueCodeableConcept: { text: 'NM_007294.4:c.5266dupC' },
          },
        ],
      },
    },
  ],
};

const PHENOPACKET = {
  id: 'synthetic-phenopacket-1',
  subject: { sex: 'FEMALE' },
  biosamples: [{ sampledTissue: { id: 'UBERON:0000178', label: 'blood' } }],
  metaData: { created: '2026-01-01T00:00:00Z', phenopacketSchemaVersion: '2.0' },
};

const CCDA = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Synthetic CCD</title>
  <effectiveTime value="20260115093000"/>
  <recordTarget><patientRole>
    <id root="2.16.840.1.113883.19.5" extension="SYN-1"/>
    <patient>
      <name><given>Pat</given><family>Synthetic</family></name>
      <administrativeGenderCode code="F" codeSystem="2.16.840.1.113883.5.1"/>
      <birthTime value="19840301"/>
    </patient>
  </patientRole></recordTarget>
  <custodian><assignedCustodian><representedCustodianOrganization>
    <name>Synthetic Health System</name>
  </representedCustodianOrganization></assignedCustodian></custodian>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
    <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Problems</title>
    <text>Hypertension, diagnosed 2019.</text>
  </section></component></structuredBody></component>
</ClinicalDocument>`;

interface Minted {
  fhir: string;
  genomics: string[];
  phenopacket: string[];
  ccda: string[];
  _cwd: string;
}

let scriptPath = '';
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

/** Run the minting script in a FRESH process, from `cwd`. */
function mintInFreshProcess(opts: { cwd: string; importedAt: string; inputPath: string }): Minted {
  if (!scriptPath) {
    const d = tempDir('cascade-identity-script-');
    scriptPath = path.join(d, 'mint.mjs');
    fs.writeFileSync(scriptPath, SCRIPT);
  }
  const stdout = execFileSync(process.execPath, [scriptPath], {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CASCADE_DIST: DIST,
      CASCADE_PAYLOAD: JSON.stringify({
        fhir: FHIR,
        genomics: GENOMICS,
        phenopacket: PHENOPACKET,
        ccda: CCDA,
        importedAt: opts.importedAt,
        inputPath: opts.inputPath,
      }),
    },
  });
  return JSON.parse(stdout) as Minted;
}

describe.skipIf(!HAVE_DIST)('identity is stable across processes and directories', () => {
  it('two separate processes from the SAME directory agree', () => {
    const cwd = tempDir('cascade-identity-a-');
    const a = mintInFreshProcess({ cwd, importedAt: '2026-01-01T00:00:00Z', inputPath: '/in/a.json' });
    const b = mintInFreshProcess({ cwd, importedAt: '2026-01-01T00:00:00Z', inputPath: '/in/a.json' });
    expect(a.fhir).toBe(b.fhir);
    expect(a.genomics).toEqual(b.genomics);
    expect(a.phenopacket).toEqual(b.phenopacket);
    expect(a.ccda).toEqual(b.ccda);
  });

  it('two separate processes from DIFFERENT directories agree', () => {
    // The 3.7 lesson: the previous defect in this family was invisible
    // precisely because every run happened from one path.
    const a = mintInFreshProcess({
      cwd: tempDir('cascade-identity-b-'),
      importedAt: '2026-01-01T00:00:00Z',
      inputPath: '/in/a.json',
    });
    const b = mintInFreshProcess({
      cwd: tempDir('cascade-identity-c-'),
      importedAt: '2026-01-01T00:00:00Z',
      inputPath: '/in/a.json',
    });
    expect(a._cwd).not.toBe(b._cwd);
    expect(a.fhir).toBe(b.fhir);
    expect(a.genomics).toEqual(b.genomics);
    expect(a.phenopacket).toEqual(b.phenopacket);
    expect(a.ccda).toEqual(b.ccda);
  });

  it('a different importedAt and a different inputPath change nothing', () => {
    const a = mintInFreshProcess({
      cwd: tempDir('cascade-identity-d-'),
      importedAt: '2026-01-01T00:00:00Z',
      inputPath: '/somewhere/original.json',
    });
    const b = mintInFreshProcess({
      cwd: tempDir('cascade-identity-e-'),
      importedAt: '2031-12-25T18:45:07Z',
      inputPath: '/elsewhere/renamed-copy.json',
    });
    expect(a.fhir).toBe(b.fhir);
    expect(a.genomics).toEqual(b.genomics);
    expect(a.phenopacket).toEqual(b.phenopacket);
    expect(a.ccda).toEqual(b.ccda);
  });

  it('and the IRIs are real, not empty', () => {
    const a = mintInFreshProcess({
      cwd: tempDir('cascade-identity-f-'),
      importedAt: '2026-01-01T00:00:00Z',
      inputPath: '/in/a.json',
    });
    expect(a.fhir).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(a.genomics.length).toBeGreaterThan(0);
    expect(a.phenopacket.length).toBeGreaterThan(0);
    expect(a.ccda.length).toBeGreaterThan(0);
  });
});
