/**
 * Tests for the MCP server tools.
 *
 * Tests the tool handler logic by importing the server creation function
 * and verifying tool registration and behavior.
 *
 * Phase 3.5: Added comprehensive tests for Turtle generation, escaping,
 * path validation, audit IDs, field mappings, and type registries.
 */

import { describe, it, expect } from 'vitest';
import { createServer } from '../src/lib/mcp/server.js';
import {
  setDefaultPodPath,
  validatePathBoundary,
  escapeTurtleString,
  formatTurtleValue,
  generatePrefixes,
  buildRecordTurtle,
  TYPE_MAPPING,
  PROPERTY_PREDICATES,
} from '../src/lib/mcp/tools.js';
import * as path from 'path';
import * as fs from 'fs';

// Reference patient pod path
const REFERENCE_POD = path.resolve(__dirname, '..', '..', 'reference-patient-pod');

// ─── Server Creation ──────────────────────────────────────────────────────────

describe('MCP Server', () => {
  it('should create a server instance', () => {
    const server = createServer();
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });
});

// ─── Audit Log ────────────────────────────────────────────────────────────────

describe('MCP Audit Log', () => {
  it('should format audit entries as Turtle', async () => {
    const { createAuditEntry } = await import('../src/lib/mcp/audit.js');
    const entry = createAuditEntry('pod_query', ['medications'], 8, 'test-agent');
    expect(entry.operation).toBe('pod_query');
    expect(entry.dataTypes).toEqual(['medications']);
    expect(entry.recordsAccessed).toBe(8);
    expect(entry.agentId).toBe('test-agent');
    expect(entry.timestamp).toBeTruthy();
  });

  it('should write audit log to a temp directory', async () => {
    const { writeAuditEntry, createAuditEntry } = await import('../src/lib/mcp/audit.js');
    const tmpDir = path.join('/tmp', `cascade-mcp-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const entry = createAuditEntry('pod_read', ['all'], 42, 'test-agent');
    await writeAuditEntry(tmpDir, entry);

    const auditLogPath = path.join(tmpDir, 'provenance', 'audit-log.ttl');
    expect(fs.existsSync(auditLogPath)).toBe(true);

    const content = fs.readFileSync(auditLogPath, 'utf-8');
    expect(content).toContain('@prefix cascade:');
    expect(content).toContain('cascade:AuditEntry');
    expect(content).toContain('"pod_read"');
    expect(content).toContain('"test-agent"');
    expect(content).toContain('42');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should append multiple entries to audit log', async () => {
    const { writeAuditEntry, createAuditEntry } = await import('../src/lib/mcp/audit.js');
    const tmpDir = path.join('/tmp', `cascade-mcp-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    await writeAuditEntry(tmpDir, createAuditEntry('pod_read', ['all'], 10));
    await writeAuditEntry(tmpDir, createAuditEntry('pod_query', ['medications'], 8));
    await writeAuditEntry(tmpDir, createAuditEntry('write', ['conditions'], 1));

    const content = fs.readFileSync(
      path.join(tmpDir, 'provenance', 'audit-log.ttl'),
      'utf-8',
    );

    // Should have prefixes only once (at the top)
    const prefixCount = (content.match(/@prefix cascade:/g) || []).length;
    expect(prefixCount).toBe(1);

    // Should have 3 audit entries
    const entryCount = (content.match(/cascade:AuditEntry/g) || []).length;
    expect(entryCount).toBe(3);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should generate UUID-based audit IDs (not sequential)', async () => {
    const { writeAuditEntry, createAuditEntry } = await import('../src/lib/mcp/audit.js');
    const tmpDir = path.join('/tmp', `cascade-mcp-test-uuid-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    await writeAuditEntry(tmpDir, createAuditEntry('pod_read', ['all'], 1));
    await writeAuditEntry(tmpDir, createAuditEntry('pod_query', ['medications'], 2));

    const content = fs.readFileSync(
      path.join(tmpDir, 'provenance', 'audit-log.ttl'),
      'utf-8',
    );

    // IDs should be UUID-based, not sequential (audit-0001, audit-0002)
    expect(content).not.toContain('audit-0001');
    expect(content).not.toContain('audit-0002');
    // Should contain UUID-pattern audit IDs
    const auditIdMatches = content.match(/<#audit-[0-9a-f-]+>/g);
    expect(auditIdMatches).not.toBeNull();
    expect(auditIdMatches!.length).toBe(2);
    // Each ID should be unique
    expect(auditIdMatches![0]).not.toBe(auditIdMatches![1]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── Tool Helpers ─────────────────────────────────────────────────────────────

describe('MCP Tool Helpers', () => {
  it('should resolve pod path from argument', () => {
    setDefaultPodPath('/tmp/test-pod');
    expect(() => setDefaultPodPath('/some/path')).not.toThrow();
  });
});

// ─── Path Validation ──────────────────────────────────────────────────────────

describe('validatePathBoundary', () => {
  it('should allow paths within the boundary', () => {
    expect(validatePathBoundary('/home/user/pod/clinical/meds.ttl', '/home/user/pod')).toBe(true);
    expect(validatePathBoundary('/home/user/pod', '/home/user/pod')).toBe(true);
    expect(validatePathBoundary('/home/user/pod/deep/nested/file.ttl', '/home/user/pod')).toBe(true);
  });

  it('should reject paths outside the boundary', () => {
    expect(validatePathBoundary('/home/user/other/file.ttl', '/home/user/pod')).toBe(false);
    expect(validatePathBoundary('/etc/passwd', '/home/user/pod')).toBe(false);
    expect(validatePathBoundary('/home/user/pod-evil/file.ttl', '/home/user/pod')).toBe(false);
  });

  it('should handle traversal attempts', () => {
    // path.resolve normalizes these, so they should resolve outside the boundary
    expect(validatePathBoundary('/home/user/pod/../../etc/passwd', '/home/user/pod')).toBe(false);
    expect(validatePathBoundary('/home/user/pod/../other/file', '/home/user/pod')).toBe(false);
  });
});

// ─── Turtle String Escaping ───────────────────────────────────────────────────

describe('escapeTurtleString', () => {
  it('should escape basic strings', () => {
    expect(escapeTurtleString('hello')).toBe('"hello"');
    expect(escapeTurtleString('')).toBe('""');
  });

  it('should escape quotes and backslashes', () => {
    expect(escapeTurtleString('say "hi"')).toBe('"say \\"hi\\""');
    expect(escapeTurtleString('path\\to\\file')).toBe('"path\\\\to\\\\file"');
  });

  it('should use long literals for strings with newlines', () => {
    const result = escapeTurtleString('line1\nline2');
    expect(result.startsWith('"""')).toBe(true);
    expect(result.endsWith('"""')).toBe(true);
  });

  it('should use long literals for long strings (>200 chars)', () => {
    const longStr = 'a'.repeat(201);
    const result = escapeTurtleString(longStr);
    expect(result.startsWith('"""')).toBe(true);
    expect(result.endsWith('"""')).toBe(true);
  });

  it('should escape tabs and carriage returns in short strings', () => {
    const result = escapeTurtleString('col1\tcol2');
    expect(result).toBe('"col1\\tcol2"');
    const result2 = escapeTurtleString('line\r');
    expect(result2).toBe('"line\\r"');
  });
});

// ─── Turtle Value Formatting ──────────────────────────────────────────────────

describe('formatTurtleValue', () => {
  it('should format booleans', () => {
    expect(formatTurtleValue('isActive', true)).toBe('true');
    expect(formatTurtleValue('isActive', false)).toBe('false');
  });

  it('should format integers without type annotation', () => {
    expect(formatTurtleValue('count', 42)).toBe('42');
    expect(formatTurtleValue('count', 0)).toBe('0');
  });

  it('should format floats with xsd:double', () => {
    expect(formatTurtleValue('confidence', 0.85)).toBe('"0.85"^^xsd:double');
  });

  it('should format date-like keys with xsd:dateTime', () => {
    expect(formatTurtleValue('startDate', '2026-01-15')).toBe('"2026-01-15"^^xsd:dateTime');
    expect(formatTurtleValue('vaccineDate', '2025-10-01')).toBe('"2025-10-01"^^xsd:dateTime');
    expect(formatTurtleValue('timestamp', '2026-02-20T10:00:00Z')).toBe('"2026-02-20T10:00:00Z"^^xsd:dateTime');
  });

  it('should format regular strings as escaped literals', () => {
    expect(formatTurtleValue('name', 'Aspirin')).toBe('"Aspirin"');
  });
});

// ─── Namespace Prefixes ───────────────────────────────────────────────────────

describe('generatePrefixes', () => {
  it('should include all required namespace prefixes', () => {
    const prefixes = generatePrefixes();
    expect(prefixes).toContain('@prefix cascade:');
    expect(prefixes).toContain('@prefix health:');
    expect(prefixes).toContain('@prefix clinical:');
    expect(prefixes).toContain('@prefix coverage:');
    expect(prefixes).toContain('@prefix fhir:');
    expect(prefixes).toContain('@prefix xsd:');
    expect(prefixes).toContain('@prefix prov:');
    expect(prefixes).toContain('https://ns.cascadeprotocol.org/core/v1#');
    expect(prefixes).toContain('https://ns.cascadeprotocol.org/health/v1#');
    expect(prefixes).toContain('https://ns.cascadeprotocol.org/clinical/v1#');
  });
});

// ─── TYPE_MAPPING Registry ────────────────────────────────────────────────────

describe('TYPE_MAPPING', () => {
  it('should map all supported data types', () => {
    const expectedTypes = ['medications', 'conditions', 'allergies', 'lab-results', 'immunizations', 'vital-signs', 'supplements'];
    for (const type of expectedTypes) {
      expect(TYPE_MAPPING[type]).toBeDefined();
      expect(TYPE_MAPPING[type].rdfType).toBeTruthy();
      expect(TYPE_MAPPING[type].nameKey).toBeTruthy();
      expect(TYPE_MAPPING[type].namePred).toBeTruthy();
    }
  });

  it('should use correct RDF types', () => {
    expect(TYPE_MAPPING['medications'].rdfType).toBe('health:MedicationRecord');
    expect(TYPE_MAPPING['conditions'].rdfType).toBe('health:ConditionRecord');
    expect(TYPE_MAPPING['allergies'].rdfType).toBe('health:AllergyRecord');
    expect(TYPE_MAPPING['lab-results'].rdfType).toBe('health:LabResultRecord');
    expect(TYPE_MAPPING['immunizations'].rdfType).toBe('health:ImmunizationRecord');
    expect(TYPE_MAPPING['vital-signs'].rdfType).toBe('clinical:VitalSign');
    expect(TYPE_MAPPING['supplements'].rdfType).toBe('clinical:Supplement');
  });
});

// ─── PROPERTY_PREDICATES Registry ─────────────────────────────────────────────

describe('PROPERTY_PREDICATES', () => {
  it('should map vaccineDate and administrationDate to health:administrationDate', () => {
    expect(PROPERTY_PREDICATES['vaccineDate']).toBe('health:administrationDate');
    expect(PROPERTY_PREDICATES['administrationDate']).toBe('health:administrationDate');
  });

  it('should have namespace-prefixed predicates for all mappings', () => {
    for (const [key, pred] of Object.entries(PROPERTY_PREDICATES)) {
      expect(pred).toMatch(/^(health|clinical|cascade|coverage|fhir|prov):/);
    }
  });

  it('should map common medical fields correctly', () => {
    expect(PROPERTY_PREDICATES['dose']).toBe('health:dose');
    expect(PROPERTY_PREDICATES['frequency']).toBe('health:frequency');
    expect(PROPERTY_PREDICATES['severity']).toBe('health:allergySeverity');
    expect(PROPERTY_PREDICATES['resultValue']).toBe('health:resultValue');
    expect(PROPERTY_PREDICATES['interpretation']).toBe('health:interpretation');
    expect(PROPERTY_PREDICATES['indication']).toBe('clinical:indication');
  });
});

// ─── buildRecordTurtle ────────────────────────────────────────────────────────

describe('buildRecordTurtle', () => {
  const mockTypeInfo = { directory: 'clinical', filename: 'medications.ttl' };

  it('should generate valid Turtle for a medication', () => {
    const turtle = buildRecordTurtle(
      'urn:uuid:test-001',
      'medications',
      mockTypeInfo,
      { name: 'Aspirin', dose: '81 mg', frequency: 'daily', isActive: true },
      { agentId: 'test-agent', reason: 'Test record' },
      '2026-02-20T10:00:00Z',
    );

    expect(turtle).toContain('<urn:uuid:test-001> a health:MedicationRecord');
    expect(turtle).toContain('health:medicationName "Aspirin"');
    expect(turtle).toContain('health:dose "81 mg"');
    expect(turtle).toContain('health:frequency "daily"');
    expect(turtle).toContain('health:isActive true');
    expect(turtle).toContain('cascade:dataProvenance cascade:AIGenerated');
    expect(turtle).toContain('cascade:schemaVersion "1.3"');
    expect(turtle).toContain('prov:wasGeneratedBy');
    expect(turtle).toContain('"test-agent"');
  });

  it('should generate valid Turtle for a condition', () => {
    const turtle = buildRecordTurtle(
      'urn:uuid:test-002',
      'conditions',
      { directory: 'clinical', filename: 'conditions.ttl' },
      { name: 'Hypertension', status: 'active', onsetDate: '2020-03-15' },
      undefined,
      '2026-02-20T10:00:00Z',
    );

    expect(turtle).toContain('a health:ConditionRecord');
    expect(turtle).toContain('health:conditionName "Hypertension"');
    expect(turtle).toContain('health:status "active"');
    expect(turtle).toContain('"2020-03-15"^^xsd:dateTime');
  });

  it('should include provenance metadata with confidence and source records', () => {
    const turtle = buildRecordTurtle(
      'urn:uuid:test-003',
      'medications',
      mockTypeInfo,
      { name: 'Lisinopril' },
      {
        agentId: 'claude-agent',
        reason: 'Drug interaction analysis',
        confidence: 0.95,
        sourceRecords: ['urn:uuid:med-001', 'urn:uuid:lab-001'],
      },
      '2026-02-20T10:00:00Z',
    );

    expect(turtle).toContain('cascade:confidence "0.95"^^xsd:double');
    expect(turtle).toContain('prov:used <urn:uuid:med-001>, <urn:uuid:lab-001>');
    expect(turtle).toContain('"Drug interaction analysis"');
  });

  it('should handle special characters in record values', () => {
    const turtle = buildRecordTurtle(
      'urn:uuid:test-004',
      'medications',
      mockTypeInfo,
      { name: 'Drug with "quotes" & specials' },
      undefined,
      '2026-02-20T10:00:00Z',
    );

    // Quotes should be escaped in the output
    expect(turtle).toContain('\\"quotes\\"');
  });

  it('should skip null and undefined values in record', () => {
    const turtle = buildRecordTurtle(
      'urn:uuid:test-005',
      'medications',
      mockTypeInfo,
      { name: 'Test', dose: null as unknown as string, frequency: undefined as unknown as string },
      undefined,
      '2026-02-20T10:00:00Z',
    );

    expect(turtle).not.toContain('health:dose');
    expect(turtle).not.toContain('health:frequency');
    expect(turtle).toContain('health:medicationName "Test"');
  });

  it('should use correct name predicate per data type', () => {
    const allergyTurtle = buildRecordTurtle(
      'urn:uuid:test-006',
      'allergies',
      { directory: 'clinical', filename: 'allergies.ttl' },
      { name: 'Penicillin', severity: 'severe' },
      undefined,
      '2026-02-20T10:00:00Z',
    );
    expect(allergyTurtle).toContain('health:allergen "Penicillin"');

    const labTurtle = buildRecordTurtle(
      'urn:uuid:test-007',
      'lab-results',
      { directory: 'clinical', filename: 'lab-results.ttl' },
      { name: 'Glucose', resultValue: '95', resultUnit: 'mg/dL' },
      undefined,
      '2026-02-20T10:00:00Z',
    );
    expect(labTurtle).toContain('health:testName "Glucose"');
  });
});
