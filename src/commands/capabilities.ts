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
  status: 'implemented' | 'placeholder' | 'phase3';
}

/** Full capabilities output */
interface CapabilitiesOutput {
  name: string;
  version: string;
  description: string;
  protocol: string;
  tools: ToolDescriptor[];
}

function getCapabilities(version: string): CapabilitiesOutput {
  return {
    name: '@cascade-protocol/cli',
    version,
    description: 'Cascade Protocol CLI - Validate, convert, and manage health data',
    protocol: 'https://cascadeprotocol.org',
    tools: [
      {
        name: 'validate',
        description: 'Validate Cascade Protocol data against SHACL shapes',
        usage: 'cascade validate <file-or-dir> [options]',
        parameters: [
          {
            name: 'file-or-dir',
            type: 'string',
            required: true,
            description: 'Turtle file or directory to validate',
          },
          {
            name: '--shapes',
            type: 'string',
            required: false,
            description: 'Path to custom SHACL shapes directory',
          },
          {
            name: '--json',
            type: 'boolean',
            required: false,
            description: 'Output results as JSON',
          },
          {
            name: '--verbose',
            type: 'boolean',
            required: false,
            description: 'Show detailed validation information',
          },
        ],
        examples: [
          'cascade validate record.ttl',
          'cascade validate ./data/ --shapes ./custom-shapes/',
          'cascade validate record.ttl --json',
        ],
        status: 'placeholder',
      },
      {
        name: 'convert',
        description: 'Convert between health data formats (FHIR, Cascade Turtle, JSON-LD)',
        usage: 'cascade convert [file] --from <format> --to <format> [options]',
        parameters: [
          {
            name: 'file',
            type: 'string',
            required: false,
            description: 'Input file (reads from stdin if omitted)',
          },
          {
            name: '--from',
            type: 'string',
            required: true,
            description: 'Source format',
            choices: ['fhir', 'cascade', 'c-cda'],
          },
          {
            name: '--to',
            type: 'string',
            required: true,
            description: 'Target format',
            choices: ['turtle', 'jsonld', 'fhir'],
          },
          {
            name: '--format',
            type: 'string',
            required: false,
            description: 'Output serialization format',
            default: 'turtle',
            choices: ['turtle', 'jsonld'],
          },
          {
            name: '--json',
            type: 'boolean',
            required: false,
            description: 'Output results as JSON',
          },
        ],
        examples: [
          'cascade convert patient.json --from fhir --to turtle',
          'cascade convert --from fhir --to cascade patient.json',
          'cat data.json | cascade convert --from fhir --to turtle',
        ],
        status: 'placeholder',
      },
      {
        name: 'pod init',
        description: 'Initialize a new Cascade Pod directory structure',
        usage: 'cascade pod init <directory>',
        parameters: [
          {
            name: 'directory',
            type: 'string',
            required: true,
            description: 'Directory to initialize as a Cascade Pod',
          },
        ],
        examples: ['cascade pod init ./my-pod', 'cascade pod init /path/to/health-data'],
        status: 'placeholder',
      },
      {
        name: 'pod query',
        description: 'Query data within a Cascade Pod',
        usage: 'cascade pod query <pod-dir> [options]',
        parameters: [
          {
            name: 'pod-dir',
            type: 'string',
            required: true,
            description: 'Path to the Cascade Pod',
          },
          {
            name: '--medications',
            type: 'boolean',
            required: false,
            description: 'Query medications',
          },
          {
            name: '--conditions',
            type: 'boolean',
            required: false,
            description: 'Query conditions',
          },
          {
            name: '--all',
            type: 'boolean',
            required: false,
            description: 'Query all data',
          },
          {
            name: '--json',
            type: 'boolean',
            required: false,
            description: 'Output as JSON',
          },
        ],
        examples: [
          'cascade pod query ./my-pod --medications',
          'cascade pod query ./my-pod --all --json',
        ],
        status: 'placeholder',
      },
      {
        name: 'pod export',
        description: 'Export Cascade Pod data',
        usage: 'cascade pod export <pod-dir> [options]',
        parameters: [
          {
            name: 'pod-dir',
            type: 'string',
            required: true,
            description: 'Path to the Cascade Pod',
          },
          {
            name: '--format',
            type: 'string',
            required: false,
            description: 'Export format',
            default: 'zip',
            choices: ['zip', 'directory'],
          },
        ],
        examples: [
          'cascade pod export ./my-pod',
          'cascade pod export ./my-pod --format directory',
        ],
        status: 'placeholder',
      },
      {
        name: 'pod info',
        description: 'Show Cascade Pod metadata and statistics',
        usage: 'cascade pod info <pod-dir>',
        parameters: [
          {
            name: 'pod-dir',
            type: 'string',
            required: true,
            description: 'Path to the Cascade Pod',
          },
        ],
        examples: ['cascade pod info ./my-pod'],
        status: 'placeholder',
      },
      {
        name: 'conformance run',
        description: 'Run conformance test suite against a CLI or self-test',
        usage: 'cascade conformance run --suite <fixtures-dir> [--command "<cmd>"|--self]',
        parameters: [
          {
            name: '--suite',
            type: 'string',
            required: true,
            description: 'Path to test fixtures directory',
          },
          {
            name: '--command',
            type: 'string',
            required: false,
            description: 'External command to test against',
          },
          {
            name: '--self',
            type: 'boolean',
            required: false,
            description: 'Run self-conformance tests',
          },
          {
            name: '--json',
            type: 'boolean',
            required: false,
            description: 'Output results as JSON',
          },
        ],
        examples: [
          'cascade conformance run --suite ./fixtures --self',
          'cascade conformance run --suite ./fixtures --command "my-tool validate"',
        ],
        status: 'placeholder',
      },
      {
        name: 'serve',
        description: 'Start local MCP-compatible agent server',
        usage: 'cascade serve [options]',
        parameters: [
          {
            name: '--mcp',
            type: 'boolean',
            required: false,
            description: 'Enable MCP (Model Context Protocol) mode',
          },
          {
            name: '--transport',
            type: 'string',
            required: false,
            description: 'Transport type',
            default: 'stdio',
            choices: ['stdio', 'sse'],
          },
          {
            name: '--port',
            type: 'string',
            required: false,
            description: 'Port for SSE transport',
            default: '3000',
          },
        ],
        examples: [
          'cascade serve --mcp',
          'cascade serve --mcp --transport sse --port 8080',
        ],
        status: 'phase3',
      },
      {
        name: 'capabilities',
        description: 'Show machine-readable JSON description of all CLI tools and parameters',
        usage: 'cascade capabilities',
        parameters: [],
        examples: ['cascade capabilities', 'cascade capabilities --json'],
        status: 'implemented',
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
