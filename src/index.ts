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
 *   conformance   Run conformance test suite
 *   serve         Start local agent server
 *   capabilities  Show machine-readable tool descriptions
 */

import { Command } from 'commander';
import { registerValidateCommand } from './commands/validate.js';
import { registerConvertCommand } from './commands/convert.js';
import { registerPodCommand } from './commands/pod/index.js';
import { registerConformanceCommand } from './commands/conformance.js';
import { registerServeCommand } from './commands/serve.js';
import { registerCapabilitiesCommand } from './commands/capabilities.js';

const program = new Command();

program
  .name('cascade')
  .description('Cascade Protocol CLI')
  .version('0.2.0')
  .option('--verbose', 'Verbose output', false)
  .option('--json', 'Output results as JSON (machine-readable)', false);

// Register all commands
registerValidateCommand(program);
registerConvertCommand(program);
registerPodCommand(program);
registerConformanceCommand(program);
registerServeCommand(program);
registerCapabilitiesCommand(program);

// Custom help text with examples
program.addHelpText(
  'after',
  `
Examples:
  cascade validate record.ttl
  cascade convert --from fhir --to cascade patient.json
  cascade pod init ./my-pod
  cascade capabilities
  cascade capabilities --json
`,
);

program.parse();
