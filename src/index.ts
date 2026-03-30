#!/usr/bin/env node

/**
 * @the-cascade-protocol/cli
 *
 * Cascade Protocol CLI - Validate, convert, and manage health data.
 *
 * Usage:
 *   cascade <command> [options]
 *
 * Commands:
 *   validate      Validate Cascade data against SHACL shapes
 *   convert       Convert between health data formats
 *   pod           Manage Cascade Pod structures
 *   agent         Natural language interface for Cascade operations
 *   conformance   Run conformance test suite
 *   serve         Start local MCP server
 *   capabilities  Show machine-readable tool descriptions
 */

import { Command } from 'commander';
import { registerValidateCommand } from './commands/validate.js';
import { registerConvertCommand } from './commands/convert.js';
import { registerReconcileCommand } from './commands/reconcile.js';
import { registerPodCommand } from './commands/pod/index.js';
import { registerConformanceCommand } from './commands/conformance.js';
import { registerServeCommand } from './commands/serve.js';
import { registerCapabilitiesCommand } from './commands/capabilities.js';
import { registerAgentCommand } from '@the-cascade-protocol/agent';
import pkg from '../package.json' with { type: 'json' };

const program = new Command();

program
  .name('cascade')
  .description('Cascade Protocol CLI')
  .version(pkg.version)
  .option('--verbose', 'Verbose output', false)
  .option('--json', 'Output results as JSON (machine-readable)', false);

// Register all commands
registerValidateCommand(program);
registerConvertCommand(program);
registerReconcileCommand(program);
registerPodCommand(program);
registerConformanceCommand(program);
registerServeCommand(program);
registerCapabilitiesCommand(program);
registerAgentCommand(program);

// Custom help text with examples
program.addHelpText(
  'after',
  `
Examples:
  cascade validate record.ttl
  cascade convert --from fhir --to cascade patient.json
  cascade convert --from fhir --to cascade --source-system primary-care patient.json
  cascade reconcile system-a.ttl system-b.ttl system-c.ttl --output merged.ttl --report report.json
  cascade pod init ./my-pod
  cascade pod import ./my-pod records.xml
  cascade pod extract ./my-pod
  cascade agent
  cascade agent serve
  cascade capabilities
  cascade capabilities --json
`,
);

program.parse();
