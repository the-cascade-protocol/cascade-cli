/**
 * Unit tests for user-resolutions persistence layer.
 *
 * Verifies that saveUserResolution() and loadUserResolutions() correctly
 * round-trip UserResolution objects, including multi-value discardedRecordUris.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  saveUserResolution,
  loadUserResolutions,
  type UserResolution,
} from '../src/lib/user-resolutions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempPodDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cli-test-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('user-resolutions', () => {
  let podDir: string;

  beforeEach(async () => {
    podDir = await makeTempPodDir();
  });

  afterEach(async () => {
    await removeTempDir(podDir);
  });

  it('round-trips a resolution with two discardedRecordUris', async () => {
    const resolution: UserResolution = {
      uri: 'urn:uuid:resolution-test-001',
      conflictId: 'health:ConditionRecord::hypertension',
      resolvedAt: new Date('2026-01-15T10:00:00.000Z'),
      resolution: 'kept-source-a',
      keptRecordUri: 'urn:uuid:record-kept-001',
      discardedRecordUris: [
        'urn:uuid:record-discarded-001',
        'urn:uuid:record-discarded-002',
      ],
    };

    await saveUserResolution(podDir, resolution);
    const loaded = await loadUserResolutions(podDir);

    const result = loaded.get(resolution.conflictId);
    expect(result).toBeDefined();
    expect(result!.discardedRecordUris).toHaveLength(2);
    expect(result!.discardedRecordUris).toContain('urn:uuid:record-discarded-001');
    expect(result!.discardedRecordUris).toContain('urn:uuid:record-discarded-002');
  });

  it('round-trips a resolution with no discardedRecordUris', async () => {
    const resolution: UserResolution = {
      uri: 'urn:uuid:resolution-test-002',
      conflictId: 'health:ConditionRecord::diabetes',
      resolvedAt: new Date('2026-02-01T08:30:00.000Z'),
      resolution: 'kept-both',
      keptRecordUri: 'urn:uuid:record-kept-002',
      discardedRecordUris: [],
    };

    await saveUserResolution(podDir, resolution);
    const loaded = await loadUserResolutions(podDir);

    const result = loaded.get(resolution.conflictId);
    expect(result).toBeDefined();
    expect(result!.discardedRecordUris).toHaveLength(0);
  });

  it('preserves other resolution fields alongside discardedRecordUris', async () => {
    const resolution: UserResolution = {
      uri: 'urn:uuid:resolution-test-003',
      conflictId: 'health:MedicationRecord::lisinopril',
      resolvedAt: new Date('2026-03-10T14:00:00.000Z'),
      resolution: 'manual-edit',
      keptRecordUri: 'urn:uuid:record-kept-003',
      discardedRecordUris: ['urn:uuid:record-discarded-003'],
      userNote: 'Merged manually',
    };

    await saveUserResolution(podDir, resolution);
    const loaded = await loadUserResolutions(podDir);

    const result = loaded.get(resolution.conflictId);
    expect(result).toBeDefined();
    expect(result!.uri).toBe(resolution.uri);
    expect(result!.resolution).toBe('manual-edit');
    expect(result!.keptRecordUri).toBe('urn:uuid:record-kept-003');
    expect(result!.discardedRecordUris).toEqual(['urn:uuid:record-discarded-003']);
    expect(result!.userNote).toBe('Merged manually');
  });
});
