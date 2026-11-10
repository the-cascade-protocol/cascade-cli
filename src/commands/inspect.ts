/**
 * cascade inspect patient <paths...>
 *
 * Which patient does each incoming health record file name?
 *
 * An application importing a family's downloaded records needs to say "this
 * file may be Leo's, not Maya's" BEFORE it imports. `pod import`'s
 * `patientMatch` verdict compares a file against ONE pod's owner and, by
 * design, carries no names or dates. This verb is the other half: it reads the
 * name and birth date each file states, so the caller can compare them against
 * every member it holds.
 *
 * THE OUTPUT IS PHI. IT GOES TO STDOUT AND NOWHERE ELSE.
 * -----------------------------------------------------
 * It is for an in-process caller that reads the pipe and keeps the values in
 * memory. There is no `--report` option on purpose, nothing here is written to
 * a file, and no warning or verbose line quotes a name or a date. A caller must
 * not log this output. `pod import --report` stays PHI-free; do not move these
 * values into it.
 *
 * Inputs are read the way `pod import` reads them: a C-CDA XML or IHE XDM zip,
 * FHIR JSON (a resource, a Bundle, an array or NDJSON), Cascade Turtle, or a
 * folder (expanded by the same source adapters, so an unzipped XDM export or
 * an Apple Health export works). A file that names no patient, an Apple Health
 * `export.xml` included, reports `incomingPatient: null`.
 *
 * Output (always JSON):
 *
 *   {
 *     "files": [
 *       {
 *         "file": "<path as given or as expanded from a folder>",
 *         "format": "c-cda" | "fhir-json" | "turtle" | "apple-health-export" | "unreadable",
 *         "incomingPatient": { "name"?: string, "birthDate"?: string } | null,
 *         "patientCount": <distinct patients the file names>
 *       }
 *     ]
 *   }
 *
 * `incomingPatient` is the first patient the file names; `patientCount` above
 * one means the file (an XDM zip, say) names more than one person.
 *
 * Exit codes (docs/exit-codes.md): 0 when every file was read (a file naming
 * nobody is still 0); 1 when an argument does not exist or a folder holds
 * nothing importable; 2 when a file exists and could not be read as the record
 * it looks like (the output is still printed, that file as `"unreadable"`).
 * "Could not read" is never reported as "names nobody".
 */

import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { printError, writeStdout, type OutputOptions } from '../lib/output.js';
import { toJsonText } from '../lib/json-output.js';
import { classifyImportInput, type ImportInputKind } from '../lib/import-input.js';
import { detectSource } from '../lib/source-adapters/registry.js';
import { readIncoming, type IncomingPatient } from '../lib/incoming-patient.js';

/** One file's entry in the `inspect patient` output. PHI: see the module note. */
export interface InspectPatientFile {
  file: string;
  format: 'c-cda' | 'fhir-json' | 'turtle' | 'apple-health-export' | 'unreadable';
  incomingPatient: IncomingPatient | null;
  patientCount: number;
}

const FORMAT_OF: Record<ImportInputKind, InspectPatientFile['format']> = {
  ccda: 'c-cda',
  'fhir-json': 'fhir-json',
  turtle: 'turtle',
};

/** Same whole-file ceiling `pod import` applies. */
const MAX_BYTES = 2_000_000_000;

async function inspectFile(filePath: string): Promise<InspectPatientFile> {
  let bytes: Buffer;
  try {
    const size = (await fs.stat(filePath)).size;
    if (size > MAX_BYTES) return { file: filePath, format: 'unreadable', incomingPatient: null, patientCount: 0 };
    bytes = await fs.readFile(filePath);
  } catch {
    return { file: filePath, format: 'unreadable', incomingPatient: null, patientCount: 0 };
  }
  const kind = classifyImportInput(filePath, bytes);
  const { patients, readable } = readIncoming(bytes, kind);
  return {
    file: filePath,
    format: readable ? FORMAT_OF[kind] : 'unreadable',
    incomingPatient: patients[0] ?? null,
    patientCount: patients.length,
  };
}

export function registerInspectCommand(program: Command): void {
  const inspect = program
    .command('inspect')
    .description('Read what a record file states, before import');

  inspect
    .command('patient')
    .description('Print the patient each file names, as JSON (PHI: stdout only, never log it)')
    .argument('<paths...>', 'Files or folders, as pod import takes')
    .addHelpText(
      'after',
      '\nThe output contains names and birth dates. It is written to stdout only; ' +
        'a caller must keep it in memory and must not log it.',
    )
    .action(async (paths: string[]) => {
      const globalOpts = program.opts() as OutputOptions;
      const files: InspectPatientFile[] = [];

      for (const arg of paths) {
        const abs = path.resolve(process.cwd(), arg);
        let isDir: boolean;
        try {
          isDir = (await fs.stat(abs)).isDirectory();
        } catch {
          printError(`No such file or folder: ${arg}`, globalOpts);
          process.exitCode = 1;
          return;
        }
        if (!isDir) {
          files.push(await inspectFile(arg));
          continue;
        }
        const adapter = detectSource(abs);
        const expanded = adapter?.expand(abs);
        if (!expanded || (expanded.files.length === 0 && (expanded.streamed ?? []).length === 0)) {
          printError(`No importable records found in ${arg}`, globalOpts);
          process.exitCode = 1;
          return;
        }
        for (const f of expanded.files) files.push(await inspectFile(f));
        for (const st of expanded.streamed ?? []) {
          // An Apple Health export.xml carries device data, not a patient record.
          files.push({ file: st.path, format: 'apple-health-export', incomingPatient: null, patientCount: 0 });
        }
      }

      // Always JSON, whatever --json says: this verb exists for a program.
      writeStdout(toJsonText({ files }));
      if (files.some((f) => f.format === 'unreadable')) process.exitCode = 2;
    });
}
