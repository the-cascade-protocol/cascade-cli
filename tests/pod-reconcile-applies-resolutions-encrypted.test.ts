/**
 * A recorded answer is carried out on an ENCRYPTED pod exactly as on a
 * plaintext one, and nothing it writes lands in the clear.
 *
 * `annotations/` and `settings/` are inside the set `pod encrypt` seals. The
 * retraction overlay a keep-one answer produces is written through the same
 * overlay writer `pod retract` uses, so it must be ciphertext on disk, readable
 * back through the DEK (`pod query --all` returns it in `other`), and a second
 * reconcile must leave every file byte-identical: the overlay's presence check
 * has to decrypt what it reads, or it would append a duplicate every run.
 *
 * Fixtures are synthetic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { loadPendingConflicts } from '../src/lib/user-resolutions.js';
import { resolveDek, readResource } from '../src/lib/pod-encryption.js';

const PASSPHRASE = 'applies-resolutions-encrypted-passphrase';
const TEST_TIMEOUT_MS = 120_000;

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = new Command();
  program
    .name('cascade')
    .exitOverride()
    .option('--verbose', 'Verbose output', false)
    .option('--json', 'Output JSON', false);
  registerPodCommand(program);

  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.map(String).join(' '));
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    out.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  class ProcessExit extends Error {
    constructor(readonly code: number) {
      super(`process.exit(${code})`);
    }
  }
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExit(code ?? 0);
  }) as never);

  process.exitCode = 0;
  let exitCode: number | undefined;
  try {
    await program.parseAsync(['node', 'cascade', ...args]);
  } catch (e) {
    if (e instanceof ProcessExit) exitCode = e.code;
    else throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  }
  const resolved = exitCode ?? (typeof process.exitCode === 'number' ? process.exitCode : 0);
  process.exitCode = 0;
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode: resolved };
}

const KEPT = 'urn:cascade:med:enc-lisinopril-pharmacy';
const OTHER = 'urn:cascade:med:enc-lisinopril-clinic';

function medTtl(uri: string, drugName: string, dosage: string): string {
  return `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .

<${uri}> a clinical:Medication ;
    clinical:drugName "${drugName}" ;
    clinical:rxNormCode <https://ns.cascadeprotocol.org/rxnorm/29046> ;
    clinical:dosage "${dosage}" ;
    clinical:status "active" ;
    cascade:dataProvenance cascade:Imported ;
    cascade:schemaVersion "1.9" .
`;
}

/**
 * Every file's PLAINTEXT. Ciphertext cannot be compared across runs: every
 * rewrite of a sealed file uses a fresh nonce, and `reconcile --apply` rewrites
 * the record buckets it reads on every run.
 */
function snapshot(dir: string, dek: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let text: string;
      try {
        text = readResource(p, dek);
      } catch {
        text = fs.readFileSync(p, 'utf-8');
      }
      out.set(path.relative(dir, p), text);
    }
  };
  walk(dir);
  return out;
}

let tmpDirs: string[] = [];
beforeEach(() => {
  process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
});
afterEach(() => {
  delete process.env.CASCADE_POD_PASSPHRASE;
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe('a recorded answer on an encrypted pod', () => {
  it('is carried out sealed, readable through the key, and idempotent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-applies-enc-'));
    tmpDirs.push(root);
    const podDir = path.join(root, 'pod');
    const a = path.join(root, 'pharmacy.ttl');
    const b = path.join(root, 'clinic.ttl');
    fs.writeFileSync(a, medTtl(KEPT, 'Lisinopril 10 mg', '10 mg'), 'utf-8');
    fs.writeFileSync(b, medTtl(OTHER, 'Lisinopril 20 mg', '20 mg'), 'utf-8');

    expect((await runCli(['pod', 'init', podDir, '--encrypt'])).exitCode).toBe(0);
    expect((await runCli(['pod', 'import', podDir, a, '--source-system', 'pharmacy'])).exitCode).toBe(0);
    expect((await runCli(['pod', 'import', podDir, b, '--source-system', 'clinic'])).exitCode).toBe(0);

    const dek = resolveDek(podDir, PASSPHRASE);
    const [row] = await loadPendingConflicts(podDir, dek);
    expect(row).toBeDefined();
    const side = row.candidateRecordUris[0] === KEPT ? 'source-a' : 'source-b';
    expect(
      (await runCli(['pod', 'resolve', podDir, '--conflict', row.conflictId, '--keep', side])).exitCode,
    ).toBe(0);

    const first = await runCli(['--json', 'pod', 'reconcile', podDir, '--apply']);
    expect(first.exitCode, first.stderr).toBe(0);
    const report = JSON.parse(first.stdout) as { userResolutions: { retractionsWritten: number } };
    expect(report.userResolutions.retractionsWritten).toBe(1);

    // Sealed on disk: no Turtle, no record IRI in the clear.
    const onDisk = fs.readFileSync(path.join(podDir, 'annotations', 'retractions.ttl')).toString('utf-8');
    expect(onDisk).not.toContain('@prefix');
    expect(onDisk).not.toContain(OTHER);
    expect(await loadPendingConflicts(podDir, dek)).toEqual([]);

    // Readable back through the key, where the Workbench reads overlays from.
    const q = await runCli(['--json', 'pod', 'query', podDir, '--all']);
    expect(q.exitCode, q.stderr).toBe(0);
    const payload = JSON.parse(q.stdout) as {
      dataTypes: Record<string, { records: Array<{ type: string; properties: Record<string, string> }> }>;
    };
    const other = payload.dataTypes.other?.records ?? [];
    const retraction = other.find((rec) => rec.type === 'workbench:Retraction');
    expect(retraction, JSON.stringify(payload.dataTypes.other)).toBeDefined();
    expect(retraction!.properties['workbench:retractsRecord']).toBe(OTHER);
    expect(retraction!.properties['workbench:supersededBy']).toBe(KEPT);

    // A second run decrypts what it finds and writes no second overlay: the
    // overlay file is not even rewritten, so its ciphertext is byte-identical,
    // and every other file is identical once decrypted.
    const retractionsFile = path.join(podDir, 'annotations', 'retractions.ttl');
    const sealedBefore = fs.readFileSync(retractionsFile);
    const before = snapshot(podDir, dek);
    const second = await runCli(['--json', 'pod', 'reconcile', podDir, '--apply']);
    expect(second.exitCode, second.stderr).toBe(0);
    const again = JSON.parse(second.stdout) as {
      userResolutions: { retractionsWritten: number; retractionsAlreadyPresent: number };
    };
    expect(again.userResolutions.retractionsWritten).toBe(0);
    expect(again.userResolutions.retractionsAlreadyPresent).toBe(1);
    expect(fs.readFileSync(retractionsFile).equals(sealedBefore)).toBe(true);
    expect(snapshot(podDir, dek)).toEqual(before);
  }, TEST_TIMEOUT_MS);
});
