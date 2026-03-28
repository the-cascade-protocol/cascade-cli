/**
 * Unit tests for pod command modules.
 *
 * Tests pod helpers (parsePod, extractLabel, etc.), pod init directory
 * structure creation, pod info record counting and provenance detection,
 * pod query filtering, and pod export (ZIP and directory copy).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolve } from 'path';
import { existsSync } from 'fs';

const CLI_PATH = resolve(__dirname, '../dist/index.js');
const REFERENCE_POD = resolve(__dirname, '../../reference-patient-pod');
const skipIfNoPod = !existsSync(REFERENCE_POD);

function runCli(args: string): string {
  try {
    return execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; status?: number };
    return (execError.stdout ?? '').trim() + (execError.stderr ?? '').trim();
  }
}

// =============================================================================
// Tests: Pod helpers (unit tests of pure functions)
// =============================================================================

import {
  DATA_TYPES,
  resolvePodDir,
  normalizeProvenanceLabel,
  extractLabelFromProps,
  selectKeyProperties,
} from '../src/commands/pod/helpers.js';

describe('Pod helpers', () => {
  describe('DATA_TYPES registry', () => {
    it('should contain all expected data types', () => {
      const expectedTypes = [
        'medications', 'conditions', 'allergies', 'lab-results',
        'immunizations', 'vital-signs', 'insurance', 'patient-profile',
        'heart-rate', 'blood-pressure', 'activity', 'sleep', 'supplements',
      ];
      for (const t of expectedTypes) {
        expect(DATA_TYPES[t]).toBeDefined();
        expect(DATA_TYPES[t].label).toBeTruthy();
        expect(DATA_TYPES[t].directory).toMatch(/^(clinical|wellness)$/);
        expect(DATA_TYPES[t].filename).toMatch(/\.ttl$/);
      }
    });

    it('should classify clinical vs wellness correctly', () => {
      expect(DATA_TYPES['medications'].directory).toBe('clinical');
      expect(DATA_TYPES['conditions'].directory).toBe('clinical');
      expect(DATA_TYPES['heart-rate'].directory).toBe('wellness');
      expect(DATA_TYPES['sleep'].directory).toBe('wellness');
    });
  });

  describe('resolvePodDir', () => {
    it('should resolve relative paths against cwd', () => {
      const result = resolvePodDir('my-pod');
      expect(result).toBe(path.resolve(process.cwd(), 'my-pod'));
    });

    it('should return absolute paths as-is', () => {
      const result = resolvePodDir('/tmp/my-pod');
      expect(result).toBe('/tmp/my-pod');
    });
  });

  describe('normalizeProvenanceLabel', () => {
    it('should convert core: prefix to cascade:', () => {
      expect(normalizeProvenanceLabel('core:ClinicalGenerated')).toBe('cascade:ClinicalGenerated');
    });

    it('should leave other prefixes unchanged', () => {
      expect(normalizeProvenanceLabel('cascade:DeviceGenerated')).toBe('cascade:DeviceGenerated');
      expect(normalizeProvenanceLabel('prov:Activity')).toBe('prov:Activity');
    });
  });

  describe('extractLabelFromProps', () => {
    it('should extract medication name', () => {
      const props = { 'health:medicationName': 'Metformin', 'health:dose': '500mg' };
      expect(extractLabelFromProps(props)).toBe('Metformin');
    });

    it('should extract condition name', () => {
      expect(extractLabelFromProps({ 'health:conditionName': 'Diabetes' })).toBe('Diabetes');
    });

    it('should extract allergen', () => {
      expect(extractLabelFromProps({ 'health:allergen': 'Penicillin' })).toBe('Penicillin');
    });

    it('should return undefined when no label key is found', () => {
      expect(extractLabelFromProps({ 'health:someOtherProp': 'value' })).toBeUndefined();
    });

    it('should prefer medicationName over other keys', () => {
      const props = {
        'health:medicationName': 'Metformin',
        'foaf:name': 'Should not be chosen',
      };
      expect(extractLabelFromProps(props)).toBe('Metformin');
    });
  });

  describe('selectKeyProperties', () => {
    it('should select medication-specific properties', () => {
      const props = {
        'health:dose': '500mg',
        'health:frequency': 'twice daily',
        'health:route': 'oral',
        'cascade:schemaVersion': '1.3',
        'health:medicationName': 'Metformin',
      };
      const result = selectKeyProperties('medications', props);
      expect(result['health:dose']).toBe('500mg');
      expect(result['health:frequency']).toBe('twice daily');
      expect(result['cascade:schemaVersion']).toBe('1.3');
    });

    it('should select condition-specific properties', () => {
      const props = {
        'health:status': 'active',
        'health:icd10Code': 'E11.9',
        'cascade:dataProvenance': 'cascade:ClinicalGenerated',
      };
      const result = selectKeyProperties('conditions', props);
      expect(result['health:status']).toBe('active');
      expect(result['health:icd10Code']).toBe('E11.9');
      expect(result['cascade:dataProvenance']).toBe('cascade:ClinicalGenerated');
    });

    it('should show first few properties for unknown type', () => {
      const props = {
        'custom:fieldA': 'A',
        'custom:fieldB': 'B',
        'custom:fieldC': 'C',
      };
      const result = selectKeyProperties('unknownType', props);
      expect(Object.keys(result).length).toBeGreaterThan(0);
      expect(Object.keys(result).length).toBeLessThanOrEqual(5);
    });
  });
});

// =============================================================================
// Tests: Pod init
// =============================================================================

describe('pod init', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join('/tmp', `cascade-test-init-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('should create the standard directory structure', () => {
    const podDir = path.join(tempDir, 'my-pod');
    runCli(`pod init ${podDir}`);

    expect(existsSync(path.join(podDir, '.well-known', 'solid'))).toBe(true);
    expect(existsSync(path.join(podDir, 'profile', 'card.ttl'))).toBe(true);
    expect(existsSync(path.join(podDir, 'settings', 'publicTypeIndex.ttl'))).toBe(true);
    expect(existsSync(path.join(podDir, 'settings', 'privateTypeIndex.ttl'))).toBe(true);
    expect(existsSync(path.join(podDir, 'clinical'))).toBe(true);
    expect(existsSync(path.join(podDir, 'wellness'))).toBe(true);
    expect(existsSync(path.join(podDir, 'index.ttl'))).toBe(true);
    expect(existsSync(path.join(podDir, 'README.md'))).toBe(true);
  });

  it('should produce valid JSON in .well-known/solid', async () => {
    const podDir = path.join(tempDir, 'json-pod');
    runCli(`pod init ${podDir}`);

    const solidJson = await fs.readFile(path.join(podDir, '.well-known', 'solid'), 'utf-8');
    const parsed = JSON.parse(solidJson);
    expect(parsed.version).toBe('1.0');
    expect(parsed.profile).toContain('card.ttl');
    expect(parsed.publicTypeIndex).toContain('publicTypeIndex.ttl');
  });

  it('should include Turtle prefixes in profile/card.ttl', async () => {
    const podDir = path.join(tempDir, 'prefix-pod');
    runCli(`pod init ${podDir}`);

    const profileContent = await fs.readFile(path.join(podDir, 'profile', 'card.ttl'), 'utf-8');
    expect(profileContent).toContain('@prefix cascade:');
    expect(profileContent).toContain('@prefix foaf:');
    expect(profileContent).toContain('schemaVersion');
  });

  it('should output JSON when --json flag is used', () => {
    const podDir = path.join(tempDir, 'json-out-pod');
    const output = runCli(`--json pod init ${podDir}`);
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('created');
    expect(parsed.files).toBeInstanceOf(Array);
    expect(parsed.files.length).toBeGreaterThan(0);
  });

  it('should error when directory already has a pod', () => {
    const podDir = path.join(tempDir, 'double-init');
    runCli(`pod init ${podDir}`);
    const output = runCli(`pod init ${podDir}`);
    expect(output).toContain('already contains');
  });
});

// =============================================================================
// Tests: Pod info (using reference patient pod)
// =============================================================================

describe.skipIf(skipIfNoPod)('pod info', () => {
  it('should output JSON with data summary', () => {
    const output = runCli(`--json pod info ${REFERENCE_POD}`);
    const parsed = JSON.parse(output);

    expect(parsed.clinical).toBeInstanceOf(Array);
    expect(parsed.wellness).toBeInstanceOf(Array);
    expect(parsed.provenanceSources).toBeInstanceOf(Array);
  });

  it('should detect record counts for clinical data', () => {
    const output = runCli(`--json pod info ${REFERENCE_POD}`);
    const parsed = JSON.parse(output);

    // The reference pod has medications, conditions, allergies, etc.
    const medEntry = parsed.clinical.find((c: any) => c.file === 'medications.ttl');
    if (medEntry) {
      expect(medEntry.records).toBeGreaterThan(0);
    }

    const condEntry = parsed.clinical.find((c: any) => c.file === 'conditions.ttl');
    if (condEntry) {
      expect(condEntry.records).toBeGreaterThan(0);
    }
  });

  it('should detect provenance information', () => {
    const output = runCli(`--json pod info ${REFERENCE_POD}`);
    const parsed = JSON.parse(output);
    expect(parsed.provenanceSources.length).toBeGreaterThan(0);
  });

  it('should include schema version', () => {
    const output = runCli(`--json pod info ${REFERENCE_POD}`);
    const parsed = JSON.parse(output);
    // Schema version may come from patient profile or index
    expect(parsed.schemaVersion).toBeTruthy();
  });

  it('should show patient name when profile exists', () => {
    const output = runCli(`--json pod info ${REFERENCE_POD}`);
    const parsed = JSON.parse(output);
    // The reference pod should have a patient name
    expect(parsed.patient).toBeDefined();
    expect(parsed.patient.name).toBeTruthy();
  });

  it('should error for non-existent pod directory', () => {
    const output = runCli(`--json pod info /tmp/nonexistent-pod-xyz`);
    expect(output).toContain('not found');
  });

  it('should produce human-readable output without --json', () => {
    const output = runCli(`pod info ${REFERENCE_POD}`);
    expect(output).toContain('Cascade Pod');
  });
});

// =============================================================================
// Tests: Pod query (using reference patient pod)
// =============================================================================

describe.skipIf(skipIfNoPod)('pod query', () => {
  it('should query medications and return records', () => {
    const output = runCli(`--json pod query ${REFERENCE_POD} --medications`);
    const parsed = JSON.parse(output);
    expect(parsed.dataTypes).toBeDefined();
    if (parsed.dataTypes.medications) {
      expect(parsed.dataTypes.medications.count).toBeGreaterThan(0);
      expect(parsed.dataTypes.medications.records).toBeInstanceOf(Array);
    }
  });

  it('should query conditions', () => {
    const output = runCli(`--json pod query ${REFERENCE_POD} --conditions`);
    const parsed = JSON.parse(output);
    if (parsed.dataTypes.conditions) {
      expect(parsed.dataTypes.conditions.count).toBeGreaterThan(0);
    }
  });

  it('should query allergies', () => {
    const output = runCli(`--json pod query ${REFERENCE_POD} --allergies`);
    const parsed = JSON.parse(output);
    if (parsed.dataTypes.allergies) {
      expect(parsed.dataTypes.allergies.count).toBeGreaterThan(0);
    }
  });

  it('should query all data types with --all flag', () => {
    const output = runCli(`--json pod query ${REFERENCE_POD} --all`);
    const parsed = JSON.parse(output);
    expect(parsed.dataTypes).toBeDefined();
    // Should have multiple data type keys
    expect(Object.keys(parsed.dataTypes).length).toBeGreaterThan(1);
  });

  it('should include record properties in query results', () => {
    const output = runCli(`--json pod query ${REFERENCE_POD} --medications`);
    const parsed = JSON.parse(output);
    if (parsed.dataTypes.medications && parsed.dataTypes.medications.records.length > 0) {
      const firstRecord = parsed.dataTypes.medications.records[0];
      expect(firstRecord.id).toBeTruthy();
      expect(firstRecord.type).toBeTruthy();
      expect(firstRecord.properties).toBeDefined();
    }
  });

  it('should error when no filter is specified', () => {
    const output = runCli(`pod query ${REFERENCE_POD}`);
    expect(output).toContain('No query filter');
  });

  it('should error for non-existent pod directory', () => {
    const output = runCli(`pod query /tmp/nonexistent-pod-xyz --all`);
    expect(output).toContain('not found');
  });
});

// =============================================================================
// Tests: Pod export
// =============================================================================

describe.skipIf(skipIfNoPod)('pod export', () => {
  let tempExportDir: string;

  beforeEach(async () => {
    tempExportDir = path.join('/tmp', `cascade-test-export-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempExportDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempExportDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('should export pod as ZIP archive', () => {
    const zipPath = path.join(tempExportDir, 'test-export.zip');
    const output = runCli(`--json pod export ${REFERENCE_POD} --format zip --output ${zipPath}`);
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('exported');
    expect(parsed.format).toBe('zip');
    expect(existsSync(zipPath)).toBe(true);
  });

  it('should export pod as directory copy', () => {
    const destDir = path.join(tempExportDir, 'pod-copy');
    const output = runCli(`--json pod export ${REFERENCE_POD} --format directory --output ${destDir}`);
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('exported');
    expect(parsed.format).toBe('directory');
    expect(existsSync(path.join(destDir, 'index.ttl'))).toBe(true);
    expect(existsSync(path.join(destDir, 'clinical'))).toBe(true);
    expect(existsSync(path.join(destDir, 'wellness'))).toBe(true);
  });

  it('should error for non-existent pod directory', () => {
    const output = runCli(`pod export /tmp/nonexistent-pod-xyz --format zip`);
    expect(output).toContain('not found');
  });

  it('should error for unknown export format', () => {
    const output = runCli(`pod export ${REFERENCE_POD} --format csv`);
    expect(output).toContain('Unknown export format');
  });
});
