/**
 * Integration test: `cascade pod resolve` honors the global --json flag.
 *
 * Regression guard for the desktop-app integration: resolve was the lone pod
 * command that printed only human-readable text, so a caller shelling it with
 * --json got non-JSON on stdout and had to parse a success string. This test
 * drives the registered command through commander with --json set and asserts a
 * single machine-readable result object plus that the conflict was cleared.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { registerResolveCommand } from '../src/commands/pod/resolve.js';
import {
  writePendingConflicts,
  loadPendingConflicts,
  type PendingConflict,
} from '../src/lib/user-resolutions.js';

const CONFLICT_ID = 'health:ConditionRecord::snomed:38341003';

async function seedPodWithConflict(): Promise<string> {
  const podDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-resolve-json-'));
  await fs.writeFile(path.join(podDir, 'index.ttl'), '');
  const conflict: PendingConflict = {
    uri: 'urn:uuid:conflict-x',
    conflictId: CONFLICT_ID,
    recordType: 'health:ConditionRecord',
    detectedAt: new Date('2026-06-15T02:31:00.000Z'),
    candidateRecordUris: ['urn:uuid:cond-htn-a', 'urn:uuid:cond-htn-b'],
    label: 'Hypertension',
    sourceA: 'clinic-east',
    sourceB: 'clinic-west',
  };
  await writePendingConflicts(podDir, [conflict]);
  return podDir;
}

/** A root program with the global --json flag and the resolve subcommand wired. */
function buildProgram(): Command {
  const program = new Command();
  program.option('--json', 'Output results as JSON (machine-readable)', false);
  const pod = program.command('pod');
  registerResolveCommand(pod, program);
  return program;
}

describe('pod resolve --json', () => {
  let podDir: string;
  let stdout: string;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    podDir = await seedPodWithConflict();
    stdout = '';
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stdout += chunk.toString();
        return true;
      });
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    await fs.rm(podDir, { recursive: true, force: true });
  });

  it('emits a single JSON result object and clears the conflict', async () => {
    await buildProgram().parseAsync([
      'node', 'cascade', '--json', 'pod', 'resolve', podDir,
      '--conflict', CONFLICT_ID, '--keep', 'source-a',
    ]);

    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      resolved: true,
      conflictId: CONFLICT_ID,
      keep: 'source-a',
      resolution: 'kept-source-a',
      keptRecordUri: 'urn:uuid:cond-htn-a',
      discardedRecordUris: ['urn:uuid:cond-htn-b'],
      remainingConflicts: 0,
    });

    // The conflict is gone from the pending list.
    const remaining = await loadPendingConflicts(podDir);
    expect(remaining).toHaveLength(0);
  });
});
