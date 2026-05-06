/**
 * Tests for the `cascade advisory` subcommand surface (TASK-4.9).
 *
 * Acceptance:
 *   - `cascade advisory --help` lists all six subcommands.
 *   - validate works on the BRCA2 + CPIC examples (success path).
 *   - apply works end-to-end with a self-signed JWS against a synthetic pod
 *     (BRCA2 example).
 *   - list / dry-run / revert / feed pull are exercised.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { Store, DataFactory, Writer } from 'n3';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  base64UrlFromBytes,
  CAP_JWS_CTY,
} from '../src/lib/advisory/jws-verifier.js';

const { namedNode, literal, quad } = DataFactory;

const EXAMPLES_DIR = path.resolve(
  os.homedir(),
  'Development/cascadeprotocol.org/drafts/advisory-v1',
);

const CLI_BIN = path.resolve(__dirname, '..', 'src', 'index.ts');
const TSX = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');

function runCli(
  args: string[],
  options: ExecFileSyncOptions = {},
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(TSX, [CLI_BIN, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    return { stdout: stdout.toString(), stderr: '', exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      exitCode: err.status ?? 1,
    };
  }
}

describe('cascade advisory --help', () => {
  it('lists all six subcommands', () => {
    const { stdout, exitCode } = runCli(['advisory', '--help']);
    expect(exitCode).toBe(0);
    for (const sub of ['validate', 'apply', 'list', 'revert', 'feed', 'dry-run']) {
      expect(stdout).toContain(sub);
    }
  });
});

describe('cascade advisory validate', () => {
  it('passes on the BRCA2 reclassification example', () => {
    const target = path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch');
    const { stdout, exitCode } = runCli(['advisory', 'validate', target]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('PASS');
    expect(stdout).toContain('VariantReclassification');
  });

  it('passes on the CPIC CYP2C19 warfarin example', () => {
    const target = path.join(EXAMPLES_DIR, 'example-cpic-cyp2c19-warfarin.ldpatch');
    const { stdout, exitCode } = runCli(['advisory', 'validate', target]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('PASS');
  });

  it('emits JSON when --json is set', () => {
    const target = path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch');
    const { stdout, exitCode } = runCli(['--json', 'advisory', 'validate', target]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { valid: boolean; envelope: { issuer: string } };
    expect(parsed.valid).toBe(true);
    expect(parsed.envelope.issuer).toContain('clingen');
  });
});

describe('cascade advisory dry-run + apply (BRCA2 end-to-end)', () => {
  let podDir: string;

  beforeEach(() => {
    podDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cli-test-'));
    // Build a tiny pod containing a Variant with CAid CA000123.
    const store = new Store();
    store.addQuad(
      quad(
        namedNode('urn:pod:variant:1'),
        namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        namedNode('https://ns.cascadeprotocol.org/genomics/v1#Variant'),
      ),
    );
    store.addQuad(
      quad(
        namedNode('urn:pod:variant:1'),
        namedNode('https://ns.cascadeprotocol.org/genomics/v1#caId'),
        literal('CA000123'),
      ),
    );
    const writer = new Writer();
    writer.addQuads(store.getQuads(null, null, null, null));
    let ttl = '';
    writer.end((_e, r) => (ttl = r ?? ''));
    fs.writeFileSync(path.join(podDir, 'state.ttl'), ttl, 'utf8');
  });

  afterEach(() => {
    fs.rmSync(podDir, { recursive: true, force: true });
  });

  it('dry-run reports 1 match and would-be triples without mutating the pod', () => {
    const target = path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch');
    const before = fs.readFileSync(path.join(podDir, 'state.ttl'), 'utf8');
    const { stdout, exitCode } = runCli(['advisory', 'dry-run', target, '--pod', podDir]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('1 match');
    expect(stdout).toContain('would insert');
    expect(stdout).toContain('Pod state unchanged.');
    const after = fs.readFileSync(path.join(podDir, 'state.ttl'), 'utf8');
    expect(after).toBe(before);
  });

  it('apply with valid JWS inserts triples and creates an activity record', () => {
    const target = path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch');
    const body = fs.readFileSync(target, 'utf8');

    // Self-sign for the test
    const { secretKey, publicKey } = ed25519.keygen();
    const header = {
      alg: 'EdDSA',
      iss: 'https://clingen.org/affiliation/40016',
      iat: Math.floor(Date.now() / 1000),
      cty: CAP_JWS_CTY,
    };
    const headerB64 = base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(header)));
    const bodyB64 = base64UrlFromBytes(new TextEncoder().encode(body));
    const sig = ed25519.sign(
      new TextEncoder().encode(`${headerB64}.${bodyB64}`),
      secretKey,
    );
    const sigB64 = base64UrlFromBytes(sig);
    const compactJws = `${headerB64}..${sigB64}`;

    const sigPath = path.join(podDir, 'advisory.jws');
    fs.writeFileSync(sigPath, compactJws, 'utf8');

    const keyHex = Buffer.from(publicKey).toString('hex');
    const { stdout, exitCode } = runCli([
      'advisory',
      'apply',
      target,
      '--pod',
      podDir,
      '--signature',
      sigPath,
      '--key',
      keyHex,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Applied advisory');
    expect(stdout).toContain('1 match');

    // Pod state should now contain the new VariantInterpretation + activity
    const stateAfter = fs.readFileSync(path.join(podDir, 'state.ttl'), 'utf8');
    expect(stateAfter).toContain('VariantInterpretation');
    expect(stateAfter).toContain('AdvisoryApplicationActivity');
    expect(stateAfter).toContain('wasRevisionOf');
  });

  it('apply rejects when the JWS signature does not match the supplied key', () => {
    const target = path.join(EXAMPLES_DIR, 'example-brca2-reclassification.ldpatch');
    const body = fs.readFileSync(target, 'utf8');

    const { secretKey } = ed25519.keygen();
    const wrongKey = ed25519.keygen().publicKey;
    const header = {
      alg: 'EdDSA',
      iss: 'https://clingen.org/affiliation/40016',
      iat: Math.floor(Date.now() / 1000),
      cty: CAP_JWS_CTY,
    };
    const headerB64 = base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(header)));
    const bodyB64 = base64UrlFromBytes(new TextEncoder().encode(body));
    const sig = ed25519.sign(
      new TextEncoder().encode(`${headerB64}.${bodyB64}`),
      secretKey,
    );
    const compactJws = `${headerB64}..${base64UrlFromBytes(sig)}`;
    const sigPath = path.join(podDir, 'advisory.jws');
    fs.writeFileSync(sigPath, compactJws, 'utf8');

    const wrongHex = Buffer.from(wrongKey).toString('hex');
    const { stderr, exitCode } = runCli([
      'advisory',
      'apply',
      target,
      '--pod',
      podDir,
      '--signature',
      sigPath,
      '--key',
      wrongHex,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/JWS verification failed/);
  });
});

describe('cascade advisory list (no entries)', () => {
  let podDir: string;
  beforeEach(() => {
    podDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cli-list-test-'));
  });
  afterEach(() => {
    fs.rmSync(podDir, { recursive: true, force: true });
  });

  it('reports no advisories on a fresh pod', () => {
    const { stdout, exitCode } = runCli(['advisory', 'list', '--pod', podDir]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('No advisories');
  });

  it('emits an empty array with --json', () => {
    const { stdout } = runCli(['--json', 'advisory', 'list', '--pod', podDir]);
    const parsed = JSON.parse(stdout) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(0);
  });
});

describe('cascade advisory revert (no activity)', () => {
  let podDir: string;
  beforeEach(() => {
    podDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cli-revert-test-'));
    // empty pod state.
    fs.writeFileSync(path.join(podDir, 'state.ttl'), '', 'utf8');
  });
  afterEach(() => {
    fs.rmSync(podDir, { recursive: true, force: true });
  });

  it('reports an error when the advisory has no recorded activity', () => {
    const { stderr, exitCode } = runCli([
      'advisory',
      'revert',
      '--pod',
      podDir,
      '--advisory',
      'urn:nonexistent:advisory',
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('No applied activity');
  });
});
