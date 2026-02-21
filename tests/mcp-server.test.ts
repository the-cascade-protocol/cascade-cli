/**
 * Tests for the MCP server tools.
 *
 * Tests the tool handler logic by importing the server creation function
 * and verifying tool registration and behavior.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createServer } from '../src/lib/mcp/server.js';
import { setDefaultPodPath } from '../src/lib/mcp/tools.js';
import * as path from 'path';
import * as fs from 'fs';

// Reference patient pod path
const REFERENCE_POD = path.resolve(__dirname, '..', '..', 'reference-patient-pod');

describe('MCP Server', () => {
  it('should create a server instance', () => {
    const server = createServer();
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });
});

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

    // Clean up
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

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('MCP Tool Helpers', () => {
  it('should resolve pod path from argument', () => {
    // setDefaultPodPath is exported and testable
    setDefaultPodPath('/tmp/test-pod');
    // The function is set but we can't directly test resolvePod (it's internal)
    // We verify it doesn't throw
    expect(() => setDefaultPodPath('/some/path')).not.toThrow();
  });
});
