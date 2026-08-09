/**
 * Builds the `cascade` command tree.
 *
 * This lives apart from `index.ts` so that exactly one function decides what
 * commands exist. `cascade capabilities` describes whatever this returns, and
 * `tests/capabilities-registry.test.ts` walks the same thing — so a command
 * registered here cannot be missing from the document an agent reads, and a
 * test cannot pass by walking a program that is not the real one.
 *
 * Nothing here parses argv; `index.ts` does that.
 */

import { Command } from 'commander';
import { registerValidateCommand } from './commands/validate.js';
import { registerConvertCommand } from './commands/convert.js';
import { registerReconcileCommand } from './commands/reconcile.js';
import { registerPodCommand } from './commands/pod/index.js';
import { registerConformanceCommand } from './commands/conformance.js';
import { registerServeCommand } from './commands/serve.js';
import { registerCapabilitiesCommand } from './commands/capabilities.js';
import { registerAdvisoryCommand } from './commands/advisory.js';
import { registerAgentCommand } from '@the-cascade-protocol/agent';
import { CLI_VERSION } from './lib/version.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('cascade')
    .description('Cascade Protocol CLI')
    .version(CLI_VERSION)
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
  registerAdvisoryCommand(program);
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
  cascade pod doctor ./my-pod
  cascade pod doctor ./my-pod --write
  cascade agent
  cascade agent serve
  cascade capabilities
  cascade capabilities --json
  cascade advisory validate advisory.ldpatch
  cascade advisory dry-run advisory.ldpatch --pod ./my-pod
  cascade advisory feed pull https://issuer.example/feed.jsonld --pod ./my-pod
`,
  );

  return program;
}
