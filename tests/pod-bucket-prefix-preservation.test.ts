/**
 * Integration acceptance for the record-data write path: import, then edit.
 *
 * The shipped defect: `pod add-record` merged into a bucket by deleting every
 * leading `@prefix` line and re-emitting a header of its own ten namespaces.
 * A bucket written by `pod import` declares `rxnorm:`, `sct:`, `loinc:`,
 * `vcard:` and `fhir:`; those five vanished while the body CURIEs that used
 * them stayed, so the file stopped parsing and the WHOLE-POD read failed with
 * `Undefined prefix "rxnorm:"`.
 *
 * The suite that let it ship built every fixture pod with `pod init` +
 * `add-record`, so no bucket under test ever held an importer-only prefix.
 * Every test here is therefore IMPORT-then-edit, and asserts a STRICT N3 parse
 * of the resulting file — the same parse the whole-pod read performs. A test
 * that only checks "the record was added" reproduces the original gap.
 *
 * All fixtures are synthetic and PHI-free.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Parser } from 'n3';
import type { Quad } from 'n3';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { appendOverlay, mintUri, iriRef, strLit } from '../src/lib/annotations.js';

const TEST_TIMEOUT_MS = 60_000;

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
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'cascade', ...args]);
  } catch {
    /* exitOverride throws; exitCode carries the failure */
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: chunks.join('\n'), exitCode };
}

let tmpDirs: string[] = [];
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-prefix-'));
  tmpDirs.push(d);
  return d;
}

beforeEach(() => { tmpDirs = []; });
afterEach(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

/**
 * A one-medication FHIR bundle whose only code is RxNorm. Importing it makes
 * the bucket declare and USE `rxnorm:`, which is precisely the prefix the old
 * header swap deleted.
 */
const RXNORM_BUNDLE = {
  resourceType: 'Bundle',
  type: 'collection',
  entry: [
    {
      resource: {
        resourceType: 'MedicationStatement',
        id: 'm1',
        status: 'active',
        medicationCodeableConcept: {
          coding: [{
            system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
            code: '860975',
            display: 'Metformin 500 MG',
          }],
        },
        subject: { reference: 'Patient/p1' },
      },
    },
  ],
};

/** Strict parse: exactly what the whole-pod read does, and what used to fail. */
function strictParse(file: string): Quad[] {
  return new Parser({ format: 'Turtle' }).parse(fs.readFileSync(file, 'utf-8'));
}

/** Init a pod and import the RxNorm bundle into it. Returns the pod dir. */
async function importedPod(): Promise<{ podDir: string; medsPath: string }> {
  const base = mkTmpDir();
  const podDir = path.join(base, 'pod');
  const bundle = path.join(base, 'bundle.json');
  fs.writeFileSync(bundle, JSON.stringify(RXNORM_BUNDLE), 'utf-8');

  expect((await runCli(['pod', 'init', podDir])).exitCode).toBe(0);
  expect((await runCli(['pod', 'import', podDir, bundle])).exitCode).toBe(0);

  const medsPath = path.join(podDir, 'clinical', 'medications.ttl');
  // The fixture must actually create the hazard, or every assertion below is
  // vacuous.
  expect(fs.readFileSync(medsPath, 'utf-8')).toContain('rxnorm:860975');
  return { podDir, medsPath };
}

describe('import then add-record: the importer\'s prefixes survive', () => {
  it('leaves the bucket parseable, with rxnorm: intact and both records present', async () => {
    const { podDir, medsPath } = await importedPod();

    const add = await runCli([
      '--json', 'pod', 'add-record', podDir,
      '--type', 'clinical:Medication',
      '--json', '{"clinical:drugName":"Vitamin D"}',
    ]);
    expect(add.exitCode).toBe(0);

    const text = fs.readFileSync(medsPath, 'utf-8');
    // THE regression assertion: a strict parse, not "the record is in there".
    expect(() => strictParse(medsPath)).not.toThrow();
    expect(text).toContain('@prefix rxnorm:');
    expect(text).toContain('rxnorm:860975');
    expect(text).toContain('Vitamin D');
    expect(text).toContain('Metformin 500 MG');
  }, TEST_TIMEOUT_MS);

  it('keeps the whole pod readable, which is the failure the user actually saw', async () => {
    const { podDir } = await importedPod();
    await runCli([
      'pod', 'add-record', podDir,
      '--type', 'clinical:Medication',
      '--json', '{"clinical:drugName":"Vitamin D"}',
    ]);

    const q = await runCli(['--json', 'pod', 'query', podDir, '--medications']);
    expect(q.exitCode).toBe(0);
    expect(q.stdout).toContain('Vitamin D');
    expect(q.stdout).toContain('Metformin 500 MG');
  }, TEST_TIMEOUT_MS);

  it('survives ten alternating add-records without accumulating or losing a declaration', async () => {
    const { podDir, medsPath } = await importedPod();
    for (let i = 0; i < 10; i++) {
      const r = await runCli([
        'pod', 'add-record', podDir,
        '--type', 'clinical:Medication',
        '--json', `{"clinical:drugName":"Supplement ${i}"}`,
      ]);
      expect(r.exitCode, `add-record ${i}`).toBe(0);
      expect(() => strictParse(medsPath), `parse after add-record ${i}`).not.toThrow();
    }
    const text = fs.readFileSync(medsPath, 'utf-8');
    expect((text.match(/@prefix rxnorm:/g) ?? []).length).toBe(1);
    expect((text.match(/@prefix clinical:/g) ?? []).length).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('re-imports cleanly after a hand-entered record was added', async () => {
    const { podDir, medsPath } = await importedPod();
    const bundle = path.join(path.dirname(podDir), 'bundle.json');

    await runCli([
      'pod', 'add-record', podDir,
      '--type', 'clinical:Medication',
      '--json', '{"clinical:drugName":"Vitamin D"}',
    ]);
    const reimport = await runCli(['pod', 'import', podDir, bundle]);
    expect(reimport.exitCode).toBe(0);

    expect(() => strictParse(medsPath)).not.toThrow();
    const text = fs.readFileSync(medsPath, 'utf-8');
    expect(text).toContain('Vitamin D');
    expect(text).toContain('rxnorm:860975');
  }, TEST_TIMEOUT_MS);
});

describe('add-record on a FRESH pod: the core: prefix vector', () => {
  it('accepts a core: property CURIE and still writes a parseable bucket', async () => {
    // `core:` is accepted by the CURIE expander but was never declared in the
    // emitted header, so a fresh pod with no import at all was bricked by
    // `Undefined prefix "core:"`. Building quads closes it by construction:
    // core: and cascade: are the same namespace, and the writer picks the
    // abbreviation.
    const podDir = path.join(mkTmpDir(), 'pod');
    expect((await runCli(['pod', 'init', podDir])).exitCode).toBe(0);

    const add = await runCli([
      'pod', 'add-record', podDir,
      '--type', 'clinical:Medication',
      '--json', '{"clinical:drugName":"Vitamin D","core:schemaVersion":"1.3"}',
    ]);
    expect(add.exitCode).toBe(0);

    const medsPath = path.join(podDir, 'clinical', 'medications.ttl');
    expect(() => strictParse(medsPath)).not.toThrow();
    const quads = strictParse(medsPath);
    expect(
      quads.some((q) => q.predicate.value === 'https://ns.cascadeprotocol.org/core/v1#schemaVersion'),
    ).toBe(true);

    const q = await runCli(['--json', 'pod', 'query', podDir, '--medications']);
    expect(q.exitCode).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('accepts every prefix its CURIE expander advertises', async () => {
    // Any prefix the expander accepts but the writer could not declare was a
    // brick. There is no longer a header to keep in sync, so this is a check
    // that the two have not drifted apart again.
    const podDir = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', podDir]);
    const add = await runCli([
      'pod', 'add-record', podDir,
      '--type', 'clinical:Medication',
      '--json', '{"clinical:drugName":"X","core:schemaVersion":"1.3","cascade:sourceSystem":"s",'
        + '"health:startDate":"2026-01-01","coverage:planName":"p","checkup:note":"n",'
        + '"pots:protocol":"p","workbench:tag":"t","fhir:status":"active"}',
    ]);
    expect(add.exitCode).toBe(0);
    expect(() => strictParse(path.join(podDir, 'clinical', 'medications.ttl'))).not.toThrow();
  }, TEST_TIMEOUT_MS);
});

describe('the patient WebID stays relative through every writer', () => {
  it('is still </profile/card.ttl#me> after add-record, six imports and an erase', async () => {
    // Re-serializing quads that came from a parse with N3's default base turns
    // </profile/card.ttl#me> into "undefined/profile/card.ttl#me" — and on the
    // import path it was demoted all the way to a string LITERAL. The file
    // still parsed, so nothing was red; it just said something else.
    const { podDir, medsPath } = await importedPod();
    const bundle = path.join(path.dirname(podDir), 'bundle.json');

    const add = await runCli([
      '--json', 'pod', 'add-record', podDir,
      '--type', 'clinical:Medication',
      '--json', '{"clinical:drugName":"Vitamin D"}',
    ]);
    expect(add.exitCode).toBe(0);
    expect(fs.readFileSync(medsPath, 'utf-8')).toContain('prov:wasAttributedTo </profile/card.ttl#me>');

    for (let i = 0; i < 6; i++) {
      expect((await runCli(['pod', 'import', podDir, bundle])).exitCode, `import ${i}`).toBe(0);
      const text = fs.readFileSync(medsPath, 'utf-8');
      expect(text, `after import ${i}`).toContain('prov:wasAttributedTo </profile/card.ttl#me>');
      expect(text, `after import ${i}`).not.toContain('undefined/profile');
      // Not a literal, either: the demotion was silent and semantic.
      expect(text, `after import ${i}`).not.toMatch(/wasAttributedTo\s+"/);
    }

    // ...and an erase of the OTHER record leaves it alone too.
    const imported = strictParse(medsPath).find(
      (q) => q.object.value === 'Metformin 500 MG',
    )!.subject.value;
    const erase = await runCli(['pod', 'erase', podDir, '--record', imported, '--confirm']);
    expect(erase.exitCode).toBe(0);

    const finalText = fs.readFileSync(medsPath, 'utf-8');
    expect(finalText).toContain('prov:wasAttributedTo </profile/card.ttl#me>');
    expect(finalText).not.toContain('undefined/profile');
    expect(() => strictParse(medsPath)).not.toThrow();
  }, TEST_TIMEOUT_MS);

  it('survives an import that RE-ROUTES an existing pod record to another bucket', async () => {
    // The one path where the import's own parse of concatenated pod text is
    // what lands on disk: a record whose rdf:type routes it to a bucket other
    // than the file it is sitting in (a hand edit, an SDK writer, a type that
    // changed). Its quads come from the merged-text parse rather than from the
    // target file, so a parse with N3's default base writes
    // "undefined/profile/card.ttl#me" into a brand new file.
    const base = mkTmpDir();
    const podDir = path.join(base, 'pod');
    const bundle = path.join(base, 'bundle.json');
    fs.writeFileSync(bundle, JSON.stringify(RXNORM_BUNDLE), 'utf-8');
    await runCli(['pod', 'init', podDir]);
    await runCli([
      'pod', 'add-record', podDir,
      '--type', 'clinical:Medication', '--json', '{"clinical:drugName":"Vitamin D"}',
    ]);

    const medsPath = path.join(podDir, 'clinical', 'medications.ttl');
    fs.writeFileSync(
      medsPath,
      fs.readFileSync(medsPath, 'utf-8')
        .replace('a clinical:Medication;', 'a health:ConditionRecord;')
        .replace('@prefix cascade:', '@prefix health: <https://ns.cascadeprotocol.org/health/v1#>.\n@prefix cascade:'),
      'utf-8',
    );

    expect((await runCli(['pod', 'import', podDir, bundle, '--no-reconcile'])).exitCode).toBe(0);

    const conditions = path.join(podDir, 'clinical', 'conditions.ttl');
    expect(fs.existsSync(conditions)).toBe(true);
    const text = fs.readFileSync(conditions, 'utf-8');
    expect(text).toContain('prov:wasAttributedTo </profile/card.ttl#me>');
    expect(text).not.toContain('undefined/profile');
  }, TEST_TIMEOUT_MS);

  it('erase keeps the erased-from bucket\'s own prefix declarations', async () => {
    const { podDir, medsPath } = await importedPod();
    const add = await runCli([
      '--json', 'pod', 'add-record', podDir,
      '--type', 'clinical:Medication',
      '--json', '{"clinical:drugName":"Vitamin D"}',
    ]);
    const uri = JSON.parse(add.stdout.slice(add.stdout.indexOf('{'), add.stdout.lastIndexOf('}') + 1)).recordUri;

    expect((await runCli(['pod', 'erase', podDir, '--record', uri, '--confirm'])).exitCode).toBe(0);

    const text = fs.readFileSync(medsPath, 'utf-8');
    expect(text).toContain('@prefix rxnorm:');
    expect(text).toContain('rxnorm:860975');
    expect(text).not.toContain('Vitamin D');
    expect(() => strictParse(medsPath)).not.toThrow();
    // The tombstone is a bucket write too, and it carries the same WebID.
    const tombstones = path.join(podDir, 'annotations', 'tombstones.ttl');
    expect(fs.readFileSync(tombstones, 'utf-8')).toContain('prov:wasAttributedTo </profile/card.ttl#me>');
  }, TEST_TIMEOUT_MS);
});

describe('an unreadable bucket is never overwritten', () => {
  /** Corrupt medications.ttl the way the shipped defect did: header only. */
  function corrupt(medsPath: string): Buffer {
    const text = fs.readFileSync(medsPath, 'utf-8');
    const body = text.split('\n').filter((l) => !l.trimStart().startsWith('@prefix')).join('\n');
    fs.writeFileSync(medsPath, body, 'utf-8');
    // The fixture must actually be broken.
    expect(() => strictParse(medsPath)).toThrow();
    return fs.readFileSync(medsPath);
  }

  it('pod import exits non-zero and leaves the file byte-identical', async () => {
    // Without this, fixing the header swap alone leaves every pod already
    // corrupted in the field ONE import away from losing the bucket entirely:
    // the import used to catch the parse failure, treat the file as empty, and
    // overwrite it.
    const { podDir, medsPath } = await importedPod();
    const bundle = path.join(path.dirname(podDir), 'bundle.json');
    const before = corrupt(medsPath);

    const r = await runCli(['pod', 'import', podDir, bundle]);
    expect(r.exitCode).not.toBe(0);
    expect(fs.readFileSync(medsPath).equals(before), 'the unreadable bucket was overwritten').toBe(true);
    expect(r.stdout).toMatch(/medications\.ttl/);
  }, TEST_TIMEOUT_MS);

  it('pod import names the refusal in its JSON report', async () => {
    const { podDir, medsPath } = await importedPod();
    const bundle = path.join(path.dirname(podDir), 'bundle.json');
    corrupt(medsPath);

    const r = await runCli(['--json', 'pod', 'import', podDir, bundle]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain('bucketsRefused');
    expect(r.stdout).toContain('clinical/medications.ttl');
  }, TEST_TIMEOUT_MS);

  it('pod add-record refuses and leaves the file byte-identical', async () => {
    const { podDir, medsPath } = await importedPod();
    const before = corrupt(medsPath);

    const r = await runCli([
      'pod', 'add-record', podDir,
      '--type', 'clinical:Medication',
      '--json', '{"clinical:drugName":"Vitamin D"}',
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(fs.readFileSync(medsPath).equals(before)).toBe(true);
    expect(r.stdout).toMatch(/Cannot read .*medications\.ttl as Turtle/);
  }, TEST_TIMEOUT_MS);

  it('a healthy bucket in the same import still gets written', async () => {
    // Per-file refusal, not a whole-run abort: the point is not to lose data,
    // not to punish the rest of the import.
    const { podDir, medsPath } = await importedPod();
    const base = path.dirname(podDir);
    const condBundle = path.join(base, 'conditions.json');
    fs.writeFileSync(condBundle, JSON.stringify({
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        RXNORM_BUNDLE.entry[0],
        {
          resource: {
            resourceType: 'Condition',
            id: 'c1',
            code: { coding: [{ system: 'http://snomed.info/sct', code: '73211009', display: 'Diabetes' }] },
            subject: { reference: 'Patient/p1' },
          },
        },
      ],
    }), 'utf-8');
    corrupt(medsPath);

    const r = await runCli(['pod', 'import', podDir, condBundle]);
    expect(r.exitCode).not.toBe(0);
    const conditions = path.join(podDir, 'clinical', 'conditions.ttl');
    expect(fs.existsSync(conditions)).toBe(true);
    expect(() => strictParse(conditions)).not.toThrow();
  }, TEST_TIMEOUT_MS);
});

describe('the scaffolding boundary holds', () => {
  it('leaves the comment-anchored profile and type-index templates intact', async () => {
    // `profile/extended.ttl` anchors PHI population on a LITERAL comment line,
    // and the type indexes are hand-authored with comments. Re-serializing them
    // would drop those comments, so they must NOT route through the bucket
    // chokepoint. If this goes red, the boundary has been crossed.
    //
    // The import below deliberately carries a LAB RESULT. The pod templates
    // name `medications.ttl`, `conditions.ttl` and `heart-rate.ttl` in their
    // commented examples, and both scaffolding writers decide "already
    // registered" with a substring check against the whole file — so importing
    // any of those three never exercises them at all, and this test would pass
    // without touching the code it is guarding.
    const base = mkTmpDir();
    const podDir = path.join(base, 'pod');
    const bundle = path.join(base, 'labs.json');
    fs.writeFileSync(bundle, JSON.stringify({
      resourceType: 'Bundle',
      type: 'collection',
      entry: [{
        resource: {
          resourceType: 'Observation',
          id: 'o1',
          status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '2345-7', display: 'Glucose' }] },
          valueQuantity: { value: 99, unit: 'mg/dL' },
          subject: { reference: 'Patient/p1' },
        },
      }],
    }), 'utf-8');

    expect((await runCli(['pod', 'init', podDir])).exitCode).toBe(0);
    expect((await runCli(['pod', 'import', podDir, bundle])).exitCode).toBe(0);
    // The scaffolding writers must actually have run, or the assertions below
    // guard nothing.
    expect(fs.readFileSync(path.join(podDir, 'index.ttl'), 'utf-8')).toContain('clinical/lab-results.ttl');
    expect(fs.readFileSync(path.join(podDir, 'settings', 'publicTypeIndex.ttl'), 'utf-8'))
      .toContain('<#lab-results>');

    await runCli([
      'pod', 'add-record', podDir,
      '--type', 'clinical:Medication',
      '--json', '{"clinical:drugName":"Vitamin D"}',
    ]);

    const ANCHORS: Array<[string[], string]> = [
      // The PHI-population regex matches this line literally. `extended.ttl` is
      // also 100% comments — zero triples — so a re-serialization would not
      // merely reformat it, it would empty it.
      [['profile', 'extended.ttl'], '# ── Demographics ──'],
      [['index.ttl'], '# Root LDP Container'],
      [['profile', 'card.ttl'], '# WebID Profile Card'],
      [['settings', 'publicTypeIndex.ttl'], '# Public Type Index'],
      [['settings', 'privateTypeIndex.ttl'], '# Private Type Index'],
    ];
    for (const [rel, anchor] of ANCHORS) {
      const p = path.join(podDir, ...rel);
      expect(fs.readFileSync(p, 'utf-8'), `${rel.join('/')} lost "${anchor}"`).toContain(anchor);
    }
  }, TEST_TIMEOUT_MS);
});

describe('overlay writers merge through the same door', () => {
  it('amend, annotate and retract all leave annotations/ parseable', async () => {
    const { podDir, medsPath } = await importedPod();
    const uri = strictParse(medsPath).find((q) => q.object.value === 'Metformin 500 MG')!.subject.value;

    expect((await runCli(['pod', 'amend', podDir, '--record', uri, '--property', 'clinical:dosage', '--value', '20mg'])).exitCode).toBe(0);
    expect((await runCli(['pod', 'annotate', podDir, '--record', uri, '--text', 'a note'])).exitCode).toBe(0);
    expect((await runCli(['pod', 'retract', podDir, '--record', uri, '--reason', 'entered in error'])).exitCode).toBe(0);

    for (const f of ['amendments.ttl', 'annotations.ttl', 'retractions.ttl']) {
      const p = path.join(podDir, 'annotations', f);
      expect(fs.existsSync(p), f).toBe(true);
      expect(() => strictParse(p), f).not.toThrow();
    }
  }, TEST_TIMEOUT_MS);

  it('still refuses to persist an overlay that fails SHACL', async () => {
    // The SHACL gate used to sit between the text merge and the write. It now
    // rides on the chokepoint's validate hook; if that hook is dropped, a
    // malformed overlay reaches disk silently.
    const { podDir } = await importedPod();
    const filePath = path.join(podDir, 'annotations', 'amendments.ttl');

    await expect(appendOverlay(podDir, {
      fileName: 'amendments.ttl',
      subjectUri: mintUri(),
      rdfType: 'workbench:Amendment',
      // workbench:amendedValue is required by the shape and deliberately absent.
      lines: [
        { predicate: 'workbench:amendsRecord', object: iriRef('urn:uuid:r') },
        { predicate: 'workbench:amendsProperty', object: strLit('clinical:dosage') },
      ],
      createdIso: new Date().toISOString(),
    }, undefined)).rejects.toThrow(/SHACL/);

    expect(fs.existsSync(filePath), 'a malformed overlay was written').toBe(false);
  }, TEST_TIMEOUT_MS);

  it('appends repeatedly without duplicating a prefix declaration', async () => {
    const { podDir, medsPath } = await importedPod();
    const uri = strictParse(medsPath).find((q) => q.object.value === 'Metformin 500 MG')!.subject.value;
    for (let i = 0; i < 5; i++) {
      expect((await runCli(['pod', 'annotate', podDir, '--record', uri, '--text', `note ${i}`])).exitCode).toBe(0);
    }
    const p = path.join(podDir, 'annotations', 'annotations.ttl');
    const text = fs.readFileSync(p, 'utf-8');
    expect((text.match(/@prefix workbench:/g) ?? []).length).toBe(1);
    expect(strictParse(p).filter((q) => q.predicate.value.endsWith('annotationText'))).toHaveLength(5);
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// The additive merge keeps what the bucket already held
// ---------------------------------------------------------------------------

/** A second one-medication bundle, a different drug, routing to the same bucket. */
const ATORVASTATIN_BUNDLE = {
  resourceType: 'Bundle',
  type: 'collection',
  entry: [
    {
      resource: {
        resourceType: 'MedicationStatement',
        id: 'm2',
        status: 'active',
        medicationCodeableConcept: {
          coding: [{
            system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
            code: '617314',
            display: 'Atorvastatin 10 MG',
          }],
        },
        subject: { reference: 'Patient/p1' },
      },
    },
  ],
};

describe('import into a bucket that already holds records', () => {
  // The additive path's `combine` opens by copying every subject the file
  // already holds into its accumulator. Delete that copy and the import writes
  // ONLY the incoming subjects: the bucket's existing records are silently
  // replaced, not merged. That is the same defect class as the silent
  // overwrite this whole change exists to close, one line away in the same
  // function, and nothing pinned it — the nearest existing test imports into a
  // NEW bucket, so it never exercises "keep what the file already holds".
  //
  // Three flag combinations reach the additive path, and they do NOT all pin
  // the line equally — stated explicitly so a future reader does not assume
  // more coverage than exists:
  //
  //   --no-reconcile-existing  PINS IT. The pod's own records are not loaded,
  //                            so the copy of `existing` is the only thing
  //                            keeping them. Deleting the loop loses them.
  //   --no-reconcile only      Does NOT pin it. `--reconcile-existing` is on by
  //                            default, so the pod's records are loaded into
  //                            `allInputs` and ride in as INCOMING quads; the
  //                            copy loop is redundant on that path. Kept as a
  //                            no-data-loss regression test, not as a tripwire.
  //   both flags               Pins it, same as the first.
  for (const flags of [
    ['--no-reconcile-existing'],
    ['--no-reconcile', '--no-reconcile-existing'],
    ['--no-reconcile'],
  ]) {
    it(`keeps the records already in the bucket when importing with ${flags.join(' ')}`, async () => {
      const base = mkTmpDir();
      const podDir = path.join(base, 'pod');
      const bundleA = path.join(base, 'a.json');
      const bundleB = path.join(base, 'b.json');
      fs.writeFileSync(bundleA, JSON.stringify(RXNORM_BUNDLE), 'utf-8');
      fs.writeFileSync(bundleB, JSON.stringify(ATORVASTATIN_BUNDLE), 'utf-8');

      expect((await runCli(['pod', 'init', podDir])).exitCode).toBe(0);
      expect((await runCli(['pod', 'import', podDir, bundleA])).exitCode).toBe(0);

      const medsPath = path.join(podDir, 'clinical', 'medications.ttl');
      const medicationSubjects = (): string[] => {
        const isMedication = (q: Quad) =>
          q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
          q.object.value === 'https://ns.cascadeprotocol.org/clinical/v1#Medication';
        return [...new Set(strictParse(medsPath).filter(isMedication).map((q) => q.subject.value))].sort();
      };

      const before = medicationSubjects();
      // The fixture must actually create the hazard, or the assertion is vacuous.
      expect(before).toHaveLength(1);

      expect((await runCli(['pod', 'import', podDir, bundleB, ...flags])).exitCode).toBe(0);

      const after = medicationSubjects();
      expect(after, 'the pre-existing record was dropped by the import').toEqual(
        expect.arrayContaining(before),
      );
      expect(after).toHaveLength(2);

      const text = fs.readFileSync(medsPath, 'utf-8');
      expect(text, 'the pre-existing record was dropped').toContain('Metformin 500 MG');
      expect(text, 'the incoming record was not written').toContain('Atorvastatin 10 MG');
      expect(() => strictParse(medsPath)).not.toThrow();
    }, TEST_TIMEOUT_MS);
  }

  it('keeps a hand-entered record when a later import lands in its bucket', async () => {
    // The user-visible shape of the same loss: `add-record` then `import`.
    const base = mkTmpDir();
    const podDir = path.join(base, 'pod');
    const bundle = path.join(base, 'b.json');
    fs.writeFileSync(bundle, JSON.stringify(ATORVASTATIN_BUNDLE), 'utf-8');

    await runCli(['pod', 'init', podDir]);
    expect((await runCli([
      'pod', 'add-record', podDir,
      '--type', 'clinical:Medication', '--json', '{"clinical:drugName":"Vitamin D"}',
    ])).exitCode).toBe(0);

    expect((await runCli(['pod', 'import', podDir, bundle, '--no-reconcile-existing'])).exitCode).toBe(0);

    const text = fs.readFileSync(path.join(podDir, 'clinical', 'medications.ttl'), 'utf-8');
    expect(text, 'the hand-entered record was dropped by the import').toContain('Vitamin D');
    expect(text).toContain('Atorvastatin 10 MG');
  }, TEST_TIMEOUT_MS);
});
