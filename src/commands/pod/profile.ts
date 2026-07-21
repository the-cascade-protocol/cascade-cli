/**
 * cascade pod profile <action>
 *
 * Manage a pod owner's public identity in profile/card.ttl.
 *
 * Subcommands:
 *   set-name <dir> <name>   Set the owner's display name (foaf:name)
 */

import type { Command } from 'commander';
import * as path from 'path';
import { printResult, printError, printVerbose, type OutputOptions } from '../../lib/output.js';
import {
  resolvePodDir,
  fileExists,
  applyCardIdentityName,
  deriveCardIdentityName,
  stripCardIdentityName,
} from './helpers.js';
import {
  isPodEncrypted,
  resolveDek,
  readResource,
  writeResource,
  PodDecryptError,
} from '../../lib/pod-encryption.js';
import { obtainPassphrase } from '../../lib/passphrase.js';

export function registerProfileSubcommand(pod: Command, program: Command): void {
  const profile = pod
    .command('profile')
    .description("Manage a pod owner's profile identity");

  profile
    .command('set-name')
    .description("Set the pod owner's display name (foaf:name) in profile/card.ttl")
    .argument('<dir>', 'Path to the Cascade Pod')
    .argument('<name>', "Owner display name (e.g. \"Jane Doe\")")
    .action(async (dir: string, name: string) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(dir);

      printVerbose(`Setting owner name for pod: ${podDir}`, globalOpts);

      // --- Validate pod dir + card ---
      if (!(await fileExists(path.join(podDir, 'index.ttl')))) {
        printError(`Pod not found at ${podDir} (no index.ttl). Run 'cascade pod init' first.`, globalOpts);
        process.exitCode = 1;
        return;
      }
      const cardPath = path.join(podDir, 'profile', 'card.ttl');
      if (!(await fileExists(cardPath))) {
        printError(`Pod is missing profile/card.ttl: ${podDir}`, globalOpts);
        process.exitCode = 1;
        return;
      }

      // --- Validate the name ---
      const identity = deriveCardIdentityName(name);
      if (!identity.fullName) {
        printError('Owner name cannot be empty.', globalOpts);
        process.exitCode = 1;
        return;
      }

      // --- If the pod is encrypted, resolve the DEK so the card read/write
      // routes through the encryption chokepoint. ---
      let dek: Buffer | undefined;
      if (isPodEncrypted(podDir)) {
        try {
          const passphrase = await obtainPassphrase();
          dek = resolveDek(podDir, passphrase);
          printVerbose('Pod is encrypted; routing card.ttl I/O through DEK.', globalOpts);
        } catch (e: unknown) {
          const msg =
            e instanceof PodDecryptError ? e.message : e instanceof Error ? e.message : String(e);
          printError(`Cannot update encrypted pod: ${msg}`, globalOpts);
          process.exitCode = 1;
          return;
        }
      }

      try {
        // Strip any existing identity triples first so re-naming an
        // already-named pod replaces rather than duplicates them.
        const cardTurtle = stripCardIdentityName(readResource(cardPath, dek));
        const updated = applyCardIdentityName(cardTurtle, identity);
        writeResource(cardPath, updated, dek);

        if (globalOpts.json) {
          printResult(
            {
              status: 'updated',
              directory: podDir,
              name: identity.fullName,
              givenName: identity.givenName,
              familyName: identity.familyName,
              encrypted: Boolean(dek),
            },
            globalOpts,
          );
        } else {
          console.log(`Set pod owner name to "${identity.fullName}" in profile/card.ttl`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        printError(`Failed to set owner name: ${message}`, globalOpts);
        process.exitCode = 1;
      }
    });
}
