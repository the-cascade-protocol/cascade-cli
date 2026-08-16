/**
 * cascade pod doctor <pod-dir> [--write]
 *
 * Diagnose, and where it is safe to do so repair, a damaged Cascade Pod.
 *
 * This is the recovery path for the refusal every record-data writer now
 * performs. `add-record`, `erase` and `import` decline to touch a bucket that
 * will not parse — correct, because appending into one is what turned a broken
 * header into lost records — but without this verb a user whose pod is already
 * damaged has no way forward inside the CLI at all.
 *
 * The engine, its safety properties and the registry live in
 * `lib/pod-doctor.ts`. This file is argument parsing, printing and the exit
 * code, and deliberately holds no repair logic.
 *
 * DRY RUN IS THE DEFAULT. `--write` is required to modify anything.
 *
 * Exit codes, on the read layer's contract:
 *   0 — nothing wrong, or everything found was repaired
 *   1 — damage remains: a dry run that found something, or a refusal. Also the
 *       usage error of there being no pod at that path.
 *   2 — something could not be READ: the pod would not open, or a resource
 *       inside it did not decrypt / is not text.
 *
 * The gap between 1 and 2 is the one that matters: "this pod is damaged" and
 * "I could not look at this pod" are different answers, and a CI job that treats
 * a locked pod as a clean one is the failure this whole area keeps producing.
 */

import type { Command } from 'commander';
import * as path from 'node:path';
import {
  printResult,
  printError,
  printErrorDetail,
  type OutputOptions,
} from '../../lib/output.js';
import { resolvePodDir, fileExists } from './helpers.js';
import { shellCommand } from '../../lib/shell-quote.js';
import { openPod, PodUnreadableError, type PodReader } from '../../lib/pod-read.js';
import {
  runPodDoctor,
  doctorExitCode,
  BACKUP_SUFFIX,
  type DoctorReport,
  type DoctorFinding,
} from '../../lib/pod-doctor.js';

/** One-line marker per finding, so a long report is still skimmable. */
const MARKER: Record<DoctorFinding['status'], string> = {
  repaired: 'FIXED',
  repairable: 'FIX  ',
  refused: 'STOP ',
  unreadable: '?????',
};

export function registerDoctorSubcommand(pod: Command, program: Command): void {
  pod
    .command('doctor')
    .description('Diagnose a damaged pod, and repair missing @prefix declarations with --write')
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    .option('--write', 'Apply the repairs. Without this nothing is modified.', false)
    .action(async (podDirArg: string, options: { write: boolean }) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(podDirArg);

      if (!(await fileExists(path.join(podDir, 'index.ttl')))) {
        printError(`Pod not found at ${podDir} (no index.ttl).`, globalOpts);
        process.exitCode = 1;
        return;
      }

      // Exit 2, not 1: a pod that will not open has told us nothing about
      // whether it is damaged, and that must not read as a clean bill of health.
      let reader: PodReader;
      try {
        reader = await openPod(podDir);
      } catch (e: unknown) {
        if (e instanceof PodUnreadableError) {
          printErrorDetail(e.message, { encrypted: true, readable: false, reason: e.reason }, globalOpts);
        } else {
          printError(e instanceof Error ? e.message : String(e), globalOpts);
        }
        process.exitCode = 2;
        return;
      }

      let report: DoctorReport;
      try {
        report = await runPodDoctor(reader, { write: options.write });
      } catch (e: unknown) {
        printError(e instanceof Error ? e.message : String(e), globalOpts);
        process.exitCode = 2;
        return;
      }

      if (globalOpts.json) {
        printResult(report, globalOpts);
      } else {
        printReport(report, podDirArg);
      }

      // A file doctor could not read at all goes to STDERR as well as into the
      // report, in both modes. Everything else here is a finding about a file
      // that was read; this one is the admission that part of the pod was not
      // examined, and it must not be reachable only by inspecting a JSON body.
      const unreadable = report.findings.filter((f) => f.status === 'unreadable');
      if (unreadable.length > 0) {
        printErrorDetail(
          `Could not read ${unreadable.length} of ${report.scanned} file(s) in ${report.pod}: ` +
            unreadable.map((f) => `${f.file} (${f.reason})`).join('; ') +
            `. This is NOT the same as those files being healthy — they were not examined.`,
          { readable: false, files: unreadable.map((f) => f.file) },
          globalOpts,
        );
      }

      process.exitCode = doctorExitCode(report);
    });
}

/** The human-readable report. Says what was found, what was done, and what is left. */
function printReport(report: DoctorReport, podDirArg: string): void {
  console.log(`Pod: ${report.pod}`);
  console.log(`Encryption: ${report.encrypted ? 'ENCRYPTED' : 'plaintext'}`);
  console.log(
    `Mode: ${report.mode === 'write' ? 'WRITE' : 'DRY RUN (nothing modified; pass --write to apply)'}`,
  );
  console.log(`Scanned ${report.scanned} .ttl file(s); ${report.healthy} healthy.\n`);

  for (const f of report.findings) {
    console.log(`  ${MARKER[f.status]} ${f.file}`);
    console.log(`        ${f.reason}`);
    if (f.missingPrefixes?.length) {
      console.log(`        declarations: ${f.missingPrefixes.map((p) => `${p}:`).join(' ')}`);
    }
    if (f.triples !== undefined && f.preservedBytes !== undefined) {
      console.log(
        `        parses after repair: yes (${f.triples} triples, ` +
          `${f.preservedBytes} bytes preserved verbatim)`,
      );
    }
    if (f.backup) console.log(`        backup: ${f.backup}`);
    if (f.nextStep) console.log(`        ${f.nextStep}`);
    console.log();
  }

  if (report.findings.length === 0) {
    console.log('Nothing to repair. Every .ttl file in this pod parses.');
    return;
  }

  const parts = [
    `${report.repaired} repaired`,
    `${report.repairable} repairable`,
    `${report.refused} refused`,
    `${report.unreadable} unreadable`,
  ];
  console.log(parts.join(', ') + '.');

  if (report.repaired > 0) {
    console.log(
      `The original of every repaired file is beside it as \`*${BACKUP_SUFFIX}\`. ` +
        `Delete those once you are satisfied.`,
    );
  }
  if (report.repairable > 0) {
    console.log(
      `Re-run with --write to apply: ${shellCommand('cascade', 'pod', 'doctor', podDirArg, '--write')}`,
    );
  }
  if (report.refused + report.unreadable > 0) {
    console.log(
      'The files marked STOP or ????? need a human decision. Doctor repairs missing ' +
        '`@prefix` declarations and nothing else, on purpose: every other repair would ' +
        'mean guessing at the contents of a health record.',
    );
  }
}
