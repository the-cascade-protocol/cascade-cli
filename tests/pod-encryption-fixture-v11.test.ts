/**
 * The committed manifest 1.1 fixture (tests/fixtures/pod-encryption-v1.1) is a
 * pod re-wrapped by `pod passphrase set`. Other readers of manifest 1.1 test
 * against it, so it has to stay what its README says it is: version 1.1, open
 * with the current passphrase, closed to the old one, and every resource
 * sealed under the one data key.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  readEncryptionManifest,
  resolveDek,
  readResource,
  decryptBytes,
  PodDecryptError,
} from '../src/lib/pod-encryption.js';

const FIXTURE = path.resolve(__dirname, 'fixtures', 'pod-encryption-v1.1');
const POD = path.join(FIXTURE, 'pod');
const CURRENT = 'birch meadow anchor violet copper lantern';
const OLD = 'copper velvet orbit lantern mossy quartz';
const PLAINTEXT_BY_DESIGN = ['README.md', 'settings/encryption.json'];

function podFiles(dir: string, root = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? podFiles(full, root) : [path.relative(root, full).split(path.sep).join('/')];
  });
}

describe('manifest 1.1 fixture', () => {
  it('is a version 1.1 manifest in the fixed key order with one primary passphrase wrap', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(POD, 'settings', 'encryption.json'), 'utf-8'));
    expect(Object.keys(raw)).toEqual(['version', 'algorithm', 'wraps']);
    expect(raw.version).toBe('1.1');
    expect(raw.wraps).toHaveLength(1);
    expect(Object.keys(raw.wraps[0])).toEqual(['by', 'label', 'createdAt', 'kdf', 'kdfParams', 'wrappedDek']);
    expect(raw.wraps[0].label).toBe('primary');
    expect(raw.wraps[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Buffer.from(raw.wraps[0].kdfParams.salt, 'base64')).toHaveLength(16);
    expect(readEncryptionManifest(POD)!.version).toBe('1.1');
  });

  it('opens with the current passphrase and not with the old one', () => {
    expect(resolveDek(POD, CURRENT)).toHaveLength(32);
    expect(() => resolveDek(POD, OLD)).toThrow(PodDecryptError);
  }, 30_000);

  it('seals every resource under the data key, and holds the imported record', () => {
    const dek = resolveDek(POD, CURRENT);
    const sealed = podFiles(POD).filter((f) => !PLAINTEXT_BY_DESIGN.includes(f));
    expect(sealed.length).toBeGreaterThanOrEqual(8);
    for (const f of sealed) {
      expect(() => decryptBytes(fs.readFileSync(path.join(POD, f)), dek), f).not.toThrow();
    }
    const meds = readResource(path.join(POD, 'clinical', 'medications.ttl'), dek);
    expect(meds).toContain('Lisinopril 10 MG');
    expect(meds).toContain('0e9d7c1a-5b2f-4f3e-8a61-00000000f001');
  }, 30_000);
});
