import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { resolve } from 'path';

const CLI_PATH = resolve(__dirname, '../dist/index.js');

function runCli(args: string): string {
  try {
    return execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; status?: number };
    // Commands that exit with non-zero still produce output
    return (execError.stdout ?? '').trim() + (execError.stderr ?? '').trim();
  }
}

describe('cascade CLI', () => {
  describe('--version', () => {
    it('should print the version number', () => {
      const output = runCli('--version');
      expect(output).toBe('0.2.0');
    });
  });

  describe('--help', () => {
    it('should print help text', () => {
      const output = runCli('--help');
      expect(output).toContain('Cascade Protocol CLI');
      expect(output).toContain('validate');
      expect(output).toContain('convert');
      expect(output).toContain('pod');
      expect(output).toContain('conformance');
      expect(output).toContain('serve');
      expect(output).toContain('capabilities');
    });

    it('should include examples in help output', () => {
      const output = runCli('--help');
      expect(output).toContain('Examples:');
      expect(output).toContain('cascade validate record.ttl');
    });
  });

  describe('capabilities', () => {
    it('should output valid JSON', () => {
      const output = runCli('capabilities');
      const parsed = JSON.parse(output);
      expect(parsed).toBeDefined();
      expect(parsed.name).toBe('@cascade-protocol/cli');
      expect(parsed.version).toBe('0.2.0');
    });

    it('should list all tools', () => {
      const output = runCli('capabilities');
      const parsed = JSON.parse(output);
      expect(parsed.tools).toBeInstanceOf(Array);
      expect(parsed.tools.length).toBeGreaterThan(0);

      const toolNames = parsed.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain('validate');
      expect(toolNames).toContain('convert');
      expect(toolNames).toContain('pod init');
      expect(toolNames).toContain('serve');
      expect(toolNames).toContain('capabilities');
    });

    it('should mark capabilities as implemented', () => {
      const output = runCli('capabilities');
      const parsed = JSON.parse(output);
      const capTool = parsed.tools.find((t: { name: string }) => t.name === 'capabilities');
      expect(capTool.status).toBe('implemented');
    });

    it('should include protocol URL', () => {
      const output = runCli('capabilities');
      const parsed = JSON.parse(output);
      expect(parsed.protocol).toBe('https://cascadeprotocol.org');
    });
  });

  describe('validate', () => {
    it('should report error for non-existent file', () => {
      const output = runCli('validate nonexistent.ttl');
      expect(output).toContain('Path not found');
    });

    it('should validate a valid Turtle file', () => {
      const podPath = resolve(__dirname, '../../reference-patient-pod/clinical/medications.ttl');
      const output = runCli(`validate ${podPath}`);
      expect(output).toContain('PASS');
    });

    it('should output JSON when --json flag is used', () => {
      const podPath = resolve(__dirname, '../../reference-patient-pod/clinical/medications.ttl');
      const output = runCli(`--json validate ${podPath}`);
      const parsed = JSON.parse(output);
      expect(parsed).toBeInstanceOf(Array);
      expect(parsed[0].valid).toBe(true);
      expect(parsed[0].quadCount).toBeGreaterThan(0);
    });

    it('should validate a directory of Turtle files', () => {
      const podPath = resolve(__dirname, '../../reference-patient-pod/clinical');
      const output = runCli(`validate ${podPath}`);
      expect(output).toContain('PASS');
      expect(output).toContain('Validation Summary');
    });
  });

  describe('global options', () => {
    it('should accept --json flag', () => {
      const output = runCli('--json capabilities');
      const parsed = JSON.parse(output);
      expect(parsed.name).toBe('@cascade-protocol/cli');
    });

    it('should accept --verbose flag', () => {
      // --verbose should not cause an error
      const output = runCli('--verbose capabilities');
      expect(output).toBeTruthy();
    });
  });
});
