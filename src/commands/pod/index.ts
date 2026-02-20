/**
 * cascade pod <subcommand>
 *
 * Manage Cascade Pod structures.
 *
 * Subcommands:
 *   init <directory>    Initialize a new Cascade Pod
 *   query <pod-dir>     Query data within a pod
 *   export <pod-dir>    Export pod data
 *   info <pod-dir>      Show pod metadata and statistics
 *
 * This module delegates to focused subcommand modules:
 *   - init.ts    Pod initialization with templates
 *   - query.ts   Data querying by type
 *   - export.ts  Pod export (zip/directory)
 *   - info.ts    Pod metadata and statistics
 */

import { Command } from 'commander';
import { registerInitSubcommand } from './init.js';
import { registerQuerySubcommand } from './query.js';
import { registerExportSubcommand } from './export.js';
import { registerInfoSubcommand } from './info.js';

export function registerPodCommand(program: Command): void {
  const pod = program.command('pod').description('Manage Cascade Pod structures');

  registerInitSubcommand(pod, program);
  registerQuerySubcommand(pod, program);
  registerExportSubcommand(pod, program);
  registerInfoSubcommand(pod, program);
}
