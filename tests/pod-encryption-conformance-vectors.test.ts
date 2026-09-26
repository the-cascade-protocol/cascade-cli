/**
 * The shared Pod encryption vectors (`conformance/pod-encryption/vectors.json`),
 * executed against this repository's reader.
 *
 * WHY THIS FILE EXISTS. The vectors are the cross-implementation contract for
 * the format in the specification's `pod-encryption.md`: positive fixtures
 * written by two implementations, headers every reader MUST refuse (with the
 * outcome), headers every reader MUST open, and file system layouts. The
 * conformance harness drives a PUBLISHED build of this tool through its
 * command line; this suite runs the same vectors against the code in this
 * checkout, so a change that breaks one fails here before it is released.
 *
 * WHAT IT ASSERTS. Every entry in every group of the manifest, not a chosen
 * subset, so a vector added upstream arrives here as a failing test rather
 * than as silence. A file system setup this suite does not know how to build
 * fails too.
 *
 * HOW AN OUTCOME IS DECIDED. The same five outcomes as the specification
 * (5.4), in the same order a reader reaches them: the header is read and
 * validated (`readEncryptionManifest`, which derives nothing), then a usable
 * wrap is required, and only then is a key derived. So every refusal outcome
 * here is, by construction, reached before any derivation.
 *
 * PATH RESOLUTION. Through `tests/helpers/conformance.ts`:
 * `CASCADE_CONFORMANCE_DIR` overrides the sibling checkout.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readEncryptionManifest,
  assertHasUsableWrap,
  unlockManifest,
  decryptBytes,
  EncryptionManifestError,
  PodDecryptError,
} from '../src/lib/pod-encryption.js';
import { isPlaintextByDesign } from '../src/lib/pod-resources.js';
import { conformancePath } from './helpers/conformance.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'dist', 'index.js');
const ROOT = conformancePath('pod-encryption');

interface Positive {
  id: string;
  path: string;
  layout: 'envelope' | 'pod';
  passphrases: string[];
  mustNotOpenWith?: string[];
}
interface HeaderVector {
  id: string;
  header: string;
  expect: string;
  tryWith: string;
  description: string;
}
interface FilesystemVector {
  id: string;
  setup: string;
  expect: string;
  description: string;
}
interface Manifest {
  positive: Positive[];
  vectors: HeaderVector[];
  filesystem: FilesystemVector[];
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'vectors.json'), 'utf-8')) as Manifest;

/** The key every file system vector tries: key B, which opens positive/ts-produced-v1.1/pod. */
const POD_KEY = 'birch meadow anchor violet copper lantern';
const POD_FIXTURE = path.join(ROOT, 'positive', 'ts-produced-v1.1', 'pod');

let scratch: string;
beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-pod-encryption-vectors-'));
});
afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/**
 * Open a Pod the way a reader does, and name the outcome (specification 5.4),
 * plus `not-encrypted` for a folder this reader would treat as plaintext.
 */
function openOutcome(pod: string, passphrase: string): string {
  let manifestRead;
  try {
    manifestRead = readEncryptionManifest(pod);
  } catch (e) {
    if (e instanceof EncryptionManifestError) {
      return e.kind === 'version-unsupported' ? 'unsupported-version' : e.kind;
    }
    throw e;
  }
  if (manifestRead === null) return 'not-encrypted';
  try {
    assertHasUsableWrap(manifestRead);
  } catch (e) {
    if (e instanceof EncryptionManifestError && e.kind === 'no-usable-wrap') return 'cannot-open';
    throw e;
  }
  try {
    const { dek } = unlockManifest(manifestRead, passphrase);
    expect(dek).toHaveLength(32);
    return 'opened';
  } catch (e) {
    if (e instanceof PodDecryptError) return 'incorrect-secret';
    throw e;
  }
}

function dekFor(pod: string, passphrase: string): Buffer {
  const m = readEncryptionManifest(pod);
  expect(m, `${pod} reads as encrypted`).not.toBeNull();
  return unlockManifest(m!, passphrase).dek;
}

function podFiles(dir: string, root = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? podFiles(full, root) : [path.relative(root, full).split(path.sep).join('/')];
  });
}

function headerPod(name: string, header: Buffer): string {
  const pod = path.join(scratch, 'header', name);
  fs.mkdirSync(path.join(pod, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(pod, 'settings', 'encryption.json'), header);
  return pod;
}

/** Build a file system vector's layout. Mirrors conformance's scripts/check_pod_encryption.py. */
function buildFilesystem(setup: string): string {
  const base = path.join(scratch, 'fs', setup);
  const pod = path.join(base, 'pod');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const valid = fs.readFileSync(path.join(POD_FIXTURE, 'settings', 'encryption.json'));
  if (setup === 'record-file-symlink-outside-pod' || setup === 'container-symlink-outside-pod') {
    fs.cpSync(POD_FIXTURE, pod, { recursive: true });
    fs.cpSync(POD_FIXTURE, path.join(outside, 'copy'), { recursive: true });
    if (setup === 'record-file-symlink-outside-pod') {
      fs.rmSync(path.join(pod, 'clinical', 'medications.ttl'));
      fs.symlinkSync(path.join(outside, 'copy', 'clinical', 'medications.ttl'), path.join(pod, 'clinical', 'medications.ttl'));
    } else {
      fs.rmSync(path.join(pod, 'clinical'), { recursive: true });
      fs.symlinkSync(path.join(outside, 'copy', 'clinical'), path.join(pod, 'clinical'), 'dir');
    }
    return pod;
  }
  const settings = path.join(pod, 'settings');
  if (setup.startsWith('settings-symlink')) {
    fs.mkdirSync(pod, { recursive: true });
    const real = path.join(outside, 'settings');
    fs.mkdirSync(real);
    if (setup === 'settings-symlink-with-header') fs.writeFileSync(path.join(real, 'encryption.json'), valid);
    fs.symlinkSync(real, settings, 'dir');
    return pod;
  }
  fs.mkdirSync(settings, { recursive: true });
  const header = path.join(settings, 'encryption.json');
  switch (setup) {
    case 'header-is-directory':
      fs.mkdirSync(header);
      break;
    case 'header-symlink-to-valid-header':
      fs.writeFileSync(path.join(outside, 'encryption.json'), valid);
      fs.symlinkSync(path.join(outside, 'encryption.json'), header);
      break;
    case 'header-dangling-symlink':
      fs.symlinkSync(path.join(outside, 'missing.json'), header);
      break;
    case 'header-fifo':
      expect(spawnSync('mkfifo', [header]).status).toBe(0);
      break;
    case 'header-symlink-to-dev-zero':
      fs.symlinkSync('/dev/zero', header);
      break;
    default:
      throw new Error(`unknown file system vector setup "${setup}": teach this suite to build it`);
  }
  return pod;
}

describe('conformance pod-encryption vectors.json', () => {
  // A loop over a group that has quietly become empty generates no tests and
  // reports green for having tested nothing.
  it('every group is present and non-empty', () => {
    expect(manifest.positive?.length, 'positive').toBeGreaterThan(0);
    expect(manifest.vectors?.length, 'vectors').toBeGreaterThan(0);
    expect(manifest.filesystem?.length, 'filesystem').toBeGreaterThan(0);
    expect(manifest.vectors.some((v) => v.expect === 'opened'), 'accept vectors').toBe(true);
    expect(manifest.vectors.some((v) => v.expect !== 'opened'), 'negative vectors').toBe(true);
  });
});

describe('positive fixtures: every key opens, and the sealed bytes decrypt', () => {
  for (const fx of manifest.positive) {
    it(`${fx.id} ${fx.path}`, () => {
      const src = path.join(ROOT, fx.path);
      expect(fx.passphrases.length).toBeGreaterThan(0);
      for (const key of fx.passphrases) {
        if (fx.layout === 'envelope') {
          const pod = headerPod(`${fx.id}-${fx.passphrases.indexOf(key)}`, fs.readFileSync(path.join(src, 'encryption.json')));
          const dek = dekFor(pod, key);
          const plain = decryptBytes(fs.readFileSync(path.join(src, 'resource.bin')), dek);
          expect(plain.equals(fs.readFileSync(path.join(src, 'plaintext.txt')))).toBe(true);
        } else {
          expect(fx.layout).toBe('pod');
          const dek = dekFor(src, key);
          const sealed = podFiles(src).filter((f) => !isPlaintextByDesign(f));
          expect(sealed.length).toBeGreaterThan(0);
          for (const f of sealed) {
            expect(() => decryptBytes(fs.readFileSync(path.join(src, f)), dek), f).not.toThrow();
          }
        }
      }
      for (const key of fx.mustNotOpenWith ?? []) {
        const pod = fx.layout === 'envelope' ? headerPod(`${fx.id}-not`, fs.readFileSync(path.join(src, 'encryption.json'))) : src;
        expect(openOutcome(pod, key)).toBe('incorrect-secret');
      }
    }, 120_000);
  }
});

describe('header vectors: the stated outcome, every refusal before any derivation', () => {
  for (const v of manifest.vectors) {
    it(`${v.id} ${v.header}: ${v.expect}`, () => {
      const pod = headerPod(v.id, fs.readFileSync(path.join(ROOT, v.header)));
      expect(openOutcome(pod, v.tryWith), v.description).toBe(v.expect);
    }, 120_000);
  }
});

function queryMedications(pod: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [CLI, '--json', 'pod', 'query', pod, '--medications'], {
    encoding: 'utf-8',
    env: { ...process.env, CASCADE_POD_PASSPHRASE: POD_KEY },
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('file system vectors', () => {
  // Without this, "the record never comes back" would also pass for a command
  // that returns nothing at all.
  it('control: the unmodified fixture Pod returns its record through the same command', () => {
    const run = queryMedications(POD_FIXTURE);
    expect(run.status, String(run.stderr)).toBe(0);
    expect(String(run.stdout)).toContain('Lisinopril');
  }, 120_000);

  for (const v of manifest.filesystem) {
    it(`${v.id} ${v.setup}: ${v.expect}`, () => {
      const pod = buildFilesystem(v.setup);
      if (v.expect === 'not-followed') {
        // Through the command, as a person would read it: the records behind
        // the link must never come back.
        const run = queryMedications(pod);
        expect(run.signal, 'the command was killed by the timeout').toBeNull();
        expect(String(run.stdout), v.description).not.toContain('Lisinopril');
        return;
      }
      expect(openOutcome(pod, POD_KEY), v.description).toBe(v.expect);
    }, 120_000);
  }
});
