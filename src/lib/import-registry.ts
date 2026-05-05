/**
 * Importer registry for `cascade convert`.
 *
 * Adding a new format is a one-line edit to the `importers` array.
 * The convert command reads this registry to:
 *   - dispatch by --from
 *   - validate --to against the chosen importer's supportedOutputs
 *   - declare per-importer CLI flags on Commander
 *   - auto-detect input format and warn on mismatch
 *   - drive --help and the `cascade capabilities` output
 *
 * Importer authors MUST NOT edit src/commands/convert.ts to add a format —
 * register here instead. This is the single coordination point for
 * parallel importer work.
 */

import type { FormatImporter, OutputFormat } from './import-types.js';
import { fhirImporter, cascadeFhirImporter } from './fhir-converter/registry-entry.js';
import { ccdaImporter } from './ccda-converter/registry-entry.js';

/**
 * The registered importers. Order is not significant for dispatch but does
 * influence auto-detection priority (first match wins) — keep more-specific
 * formats earlier when adding new entries.
 */
export const importers: ReadonlyArray<FormatImporter> = [
  fhirImporter,
  ccdaImporter,
  cascadeFhirImporter,
];

/** Look up an importer by --from value. */
export function getImporter(format: string): FormatImporter | undefined {
  return importers.find((i) => i.format === format);
}

/** All registered --from values, for help text and validation. */
export function listFormats(): string[] {
  return importers.map((i) => i.format);
}

/**
 * Content-based auto-detect. Returns the first importer whose detect()
 * matches the input. Used to warn when --from contradicts content.
 */
export function autoDetect(input: string | Buffer): FormatImporter | undefined {
  return importers.find((i) => {
    try {
      return i.detect(input);
    } catch {
      return false;
    }
  });
}

/** Aggregate set of every output format any importer supports. */
export function allSupportedOutputs(): OutputFormat[] {
  const set = new Set<OutputFormat>();
  for (const i of importers) {
    for (const o of i.supportedOutputs) set.add(o);
  }
  return Array.from(set);
}
