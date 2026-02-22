/**
 * cascade capabilities
 *
 * Output a machine-readable JSON description of all CLI commands and their
 * parameters. Designed for consumption by AI agents and tooling.
 */

import { Command } from 'commander';
import { printResult, type OutputOptions } from '../lib/output.js';

/** Tool parameter descriptor for capabilities output */
interface ToolParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
  default?: string;
  choices?: string[];
}

/** Tool descriptor for capabilities output */
interface ToolDescriptor {
  name: string;
  description: string;
  usage: string;
  parameters: ToolParameter[];
  examples: string[];
  status: 'implemented';
}

/** MCP tool descriptor */
interface McpToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required: boolean; enum?: string[] }>;
}

/** Full capabilities output */
interface CapabilitiesOutput {
  name: string;
  version: string;
  description: string;
  protocol: string;
  tools: ToolDescriptor[];
  mcpTools: McpToolDescriptor[];
  securityModel: Record<string, string>;
}

function getCapabilities(version: string): CapabilitiesOutput {
  return {
    name: '@the-cascade-protocol/cli',
    version,
    description: 'Cascade Protocol CLI - Validate, convert, and manage health data with zero network calls',
    protocol: 'https://cascadeprotocol.org',
    securityModel: {
      networkCalls: 'zero — all operations are local',
      dataStorage: 'local filesystem only',
      provenance: 'all agent-written data tagged with AIGenerated provenance',
      auditLog: 'all MCP operations logged to provenance/audit-log.ttl',
    },
    tools: [
      {
        name: 'validate',
        description: 'Validate Cascade Protocol data against SHACL shapes',
        usage: 'cascade validate <file-or-dir> [options]',
        parameters: [
          { name: 'file-or-dir', type: 'string', required: true, description: 'Turtle file or directory to validate' },
          { name: '--shapes', type: 'string', required: false, description: 'Path to custom SHACL shapes directory' },
          { name: '--json', type: 'boolean', required: false, description: 'Output results as JSON' },
          { name: '--verbose', type: 'boolean', required: false, description: 'Show detailed validation information' },
        ],
        examples: ['cascade validate record.ttl', 'cascade validate ./data/ --json'],
        status: 'implemented',
      },
      {
        name: 'convert',
        description: 'Convert between health data formats (FHIR R4 JSON, Cascade Turtle, JSON-LD)',
        usage: 'cascade convert [file] --from <format> --to <format> [options]',
        parameters: [
          { name: 'file', type: 'string', required: false, description: 'Input file (reads from stdin if omitted)' },
          { name: '--from', type: 'string', required: true, description: 'Source format', choices: ['fhir', 'cascade'] },
          { name: '--to', type: 'string', required: true, description: 'Target format', choices: ['turtle', 'jsonld', 'fhir'] },
          { name: '--format', type: 'string', required: false, description: 'Output serialization format', default: 'turtle', choices: ['turtle', 'jsonld'] },
          { name: '--json', type: 'boolean', required: false, description: 'Output results as JSON' },
        ],
        examples: ['cascade convert patient.json --from fhir --to turtle', 'cat data.json | cascade convert --from fhir --to turtle'],
        status: 'implemented',
      },
      {
        name: 'pod init',
        description: 'Initialize a new Cascade Pod directory structure',
        usage: 'cascade pod init <directory>',
        parameters: [{ name: 'directory', type: 'string', required: true, description: 'Directory to initialize as a Cascade Pod' }],
        examples: ['cascade pod init ./my-pod'],
        status: 'implemented',
      },
      {
        name: 'pod query',
        description: 'Query data within a Cascade Pod by type',
        usage: 'cascade pod query <pod-dir> [options]',
        parameters: [
          { name: 'pod-dir', type: 'string', required: true, description: 'Path to the Cascade Pod' },
          { name: '--medications', type: 'boolean', required: false, description: 'Query medications' },
          { name: '--conditions', type: 'boolean', required: false, description: 'Query conditions' },
          { name: '--allergies', type: 'boolean', required: false, description: 'Query allergies' },
          { name: '--lab-results', type: 'boolean', required: false, description: 'Query lab results' },
          { name: '--all', type: 'boolean', required: false, description: 'Query all data' },
          { name: '--json', type: 'boolean', required: false, description: 'Output as JSON' },
        ],
        examples: ['cascade pod query ./my-pod --medications --json', 'cascade pod query ./my-pod --all --json'],
        status: 'implemented',
      },
      {
        name: 'pod info',
        description: 'Show Cascade Pod metadata and statistics',
        usage: 'cascade pod info <pod-dir>',
        parameters: [{ name: 'pod-dir', type: 'string', required: true, description: 'Path to the Cascade Pod' }],
        examples: ['cascade pod info ./my-pod'],
        status: 'implemented',
      },
      {
        name: 'pod export',
        description: 'Export Cascade Pod data as ZIP or directory',
        usage: 'cascade pod export <pod-dir> [options]',
        parameters: [
          { name: 'pod-dir', type: 'string', required: true, description: 'Path to the Cascade Pod' },
          { name: '--format', type: 'string', required: false, description: 'Export format', default: 'zip', choices: ['zip', 'directory'] },
        ],
        examples: ['cascade pod export ./my-pod', 'cascade pod export ./my-pod --format directory'],
        status: 'implemented',
      },
      {
        name: 'conformance run',
        description: 'Run conformance test suite (53 fixtures)',
        usage: 'cascade conformance run --suite <fixtures-dir> --self',
        parameters: [
          { name: '--suite', type: 'string', required: true, description: 'Path to test fixtures directory' },
          { name: '--self', type: 'boolean', required: false, description: 'Run self-conformance tests' },
          { name: '--json', type: 'boolean', required: false, description: 'Output results as JSON' },
        ],
        examples: ['cascade conformance run --suite ./fixtures --self'],
        status: 'implemented',
      },
      {
        name: 'serve',
        description: 'Start local MCP-compatible agent server',
        usage: 'cascade serve --mcp [options]',
        parameters: [
          { name: '--mcp', type: 'boolean', required: true, description: 'Enable MCP (Model Context Protocol) mode' },
          { name: '--transport', type: 'string', required: false, description: 'Transport type', default: 'stdio', choices: ['stdio', 'sse'] },
          { name: '--port', type: 'string', required: false, description: 'Port for SSE transport', default: '3000' },
          { name: '--pod', type: 'string', required: false, description: 'Default Pod directory path' },
        ],
        examples: ['cascade serve --mcp', 'cascade serve --mcp --transport sse --port 3000'],
        status: 'implemented',
      },
      {
        name: 'capabilities',
        description: 'Show machine-readable JSON description of all CLI tools and MCP tools',
        usage: 'cascade capabilities',
        parameters: [],
        examples: ['cascade capabilities'],
        status: 'implemented',
      },
    ],
    mcpTools: [
      {
        name: 'cascade_pod_read',
        description: 'Read a Cascade Pod and return a JSON summary of all contents',
        parameters: { path: { type: 'string', description: 'Pod directory path (optional, uses CASCADE_POD_PATH)', required: false } },
      },
      {
        name: 'cascade_pod_query',
        description: 'Query records from a Pod by data type',
        parameters: {
          path: { type: 'string', description: 'Pod directory path (optional)', required: false },
          dataType: { type: 'string', description: 'Data type to query', required: true, enum: ['medications', 'conditions', 'allergies', 'lab-results', 'immunizations', 'vital-signs', 'supplements', 'insurance', 'patient-profile', 'heart-rate', 'blood-pressure', 'activity', 'sleep', 'all'] },
        },
      },
      {
        name: 'cascade_validate',
        description: 'Validate Turtle data against SHACL shapes',
        parameters: {
          path: { type: 'string', description: 'File or directory path', required: false },
          content: { type: 'string', description: 'Inline Turtle content', required: false },
        },
      },
      {
        name: 'cascade_convert',
        description: 'Convert between FHIR R4 JSON and Cascade Turtle/JSON-LD',
        parameters: {
          content: { type: 'string', description: 'Content to convert', required: true },
          from: { type: 'string', description: 'Source format', required: true, enum: ['fhir', 'cascade'] },
          to: { type: 'string', description: 'Target format', required: true, enum: ['cascade', 'fhir'] },
          format: { type: 'string', description: 'Output format (turtle or jsonld)', required: false, enum: ['turtle', 'jsonld'] },
        },
      },
      {
        name: 'cascade_write',
        description: 'Write a health record to a Pod with AIGenerated provenance',
        parameters: {
          path: { type: 'string', description: 'Pod directory path (optional)', required: false },
          dataType: { type: 'string', description: 'Record type', required: true, enum: ['medications', 'conditions', 'allergies', 'lab-results', 'immunizations', 'vital-signs', 'supplements'] },
          record: { type: 'object', description: 'JSON object with record fields', required: true },
          provenance: { type: 'object', description: 'Provenance metadata (agentId, reason, confidence, sourceRecords)', required: false },
        },
      },
      {
        name: 'cascade_capabilities',
        description: 'Describe all available tools and their schemas',
        parameters: {},
      },
    ],
  };
}

export function registerCapabilitiesCommand(program: Command): void {
  program
    .command('capabilities')
    .description('Show machine-readable tool descriptions')
    .action(() => {
      const globalOpts = program.opts() as OutputOptions;
      const version = program.version() ?? '0.1.0';
      const capabilities = getCapabilities(version);

      // Capabilities always outputs JSON, regardless of --json flag
      // This is intentional: the purpose of this command is machine-readable output
      if (globalOpts.json) {
        printResult(capabilities, { json: true, verbose: globalOpts.verbose });
      } else {
        // Even in non-JSON mode, output formatted JSON for readability
        printResult(capabilities, { json: true, verbose: globalOpts.verbose });
      }
    });
}
