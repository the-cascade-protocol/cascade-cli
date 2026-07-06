/**
 * Regression test: `cascade pod init` must emit only well-formed Turtle.
 *
 * A previous template wrote profile/extended.ttl as a `<#me>` subject with
 * every predicate commented out followed by a bare `.`, which is invalid
 * Turtle ("Unexpected . on line 32"). Every freshly initialized pod then
 * shipped one unparseable file, and `cascade validate` reported a violation
 * on a clean pod. The template fix landed earlier; this test is the missing
 * guard: init a pod and assert every emitted .ttl parses cleanly through the
 * repo's own Turtle parser.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolve } from 'path';
import { parseTurtleFile } from '../src/lib/turtle-parser.js';

const CLI_PATH = resolve(__dirname, '../dist/index.js');

async function ttlFilesIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await ttlFilesIn(full)));
    } else if (entry.isFile() && entry.name.endsWith('.ttl')) {
      out.push(full);
    }
  }
  return out;
}

describe('pod init emits valid Turtle', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      tempDir = undefined;
    }
  });

  it('every emitted .ttl file parses without errors', async () => {
    tempDir = path.join('/tmp', `cascade-test-init-ttl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const podDir = path.join(tempDir, 'pod');
    execSync(`node ${CLI_PATH} pod init ${podDir}`, { encoding: 'utf-8', timeout: 30000 });

    const ttlFiles = await ttlFilesIn(podDir);
    // Sanity: the standard template ships several .ttl files.
    expect(ttlFiles.length).toBeGreaterThanOrEqual(4);

    for (const file of ttlFiles) {
      const result = await parseTurtleFile(file);
      const rel = path.relative(podDir, file);
      expect(result.errors, `${rel} should parse without errors, got: ${JSON.stringify(result.errors)}`).toEqual([]);
      expect(result.success, `${rel} should parse successfully`).toBe(true);
    }
  });

  it('profile/extended.ttl specifically parses clean (regression for the bare-dot bug)', async () => {
    tempDir = path.join('/tmp', `cascade-test-init-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const podDir = path.join(tempDir, 'pod');
    execSync(`node ${CLI_PATH} pod init ${podDir}`, { encoding: 'utf-8', timeout: 30000 });

    const result = await parseTurtleFile(path.join(podDir, 'profile', 'extended.ttl'));
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });
});
