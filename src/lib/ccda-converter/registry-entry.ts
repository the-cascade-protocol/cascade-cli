/**
 * Registry adapter for the C-CDA → Cascade converter.
 *
 * Wraps the legacy convertCcda() in src/lib/ccda-converter/index.ts as a
 * FormatImporter. The legacy converter is unchanged.
 *
 * Sidecar feature: --extract-narratives writes a JSON sidecar with all
 * narrative blocks per IHE XDM document. Implemented in postProcess so
 * the convert.ts dispatcher stays format-agnostic.
 */

import AdmZip from 'adm-zip';
import { writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

import type {
  FormatImporter,
  ImportResult,
  ImportWarning,
} from '../import-types.js';
import type { BatchConversionResult } from '../fhir-converter/types.js';
import { convertCcda } from './index.js';
import { parseCcdaXml } from './parser.js';
import { collectNarrativeBlocks, type NarrativeBlock } from './narrative-extractor.js';

function adapt(r: BatchConversionResult): ImportResult {
  const warnings: ImportWarning[] = r.warnings.map((message) => ({ message }));
  return {
    success: r.success,
    output: r.output,
    format: r.format,
    resourceCount: r.resourceCount,
    skippedCount: r.skippedCount,
    warnings,
    errors: r.errors,
    vocabularyGaps: [],
    importedIdentifiers: [],
    records: r.results.map((res) => ({
      resourceType: res.resourceType,
      cascadeType: res.cascadeType,
      warnings: res.warnings,
    })),
  };
}

export const ccdaImporter: FormatImporter = {
  format: 'c-cda',
  description: 'HL7 C-CDA R2.1 XML (single document or IHE XDM zip bundle)',
  supportedOutputs: ['turtle', 'jsonld', 'cascade'],

  detect(input) {
    // ZIP magic bytes — IHE XDM bundles are binary.
    if (Buffer.isBuffer(input)) {
      return input.length >= 2 && input[0] === 0x50 && input[1] === 0x4b;
    }
    const trimmed = input.trim();
    return trimmed.startsWith('<?xml') || trimmed.includes('<ClinicalDocument');
  },

  async convert(input, _to, ctx) {
    const r = await convertCcda(input, {
      sourceSystem: ctx.sourceSystem,
      importedAt: ctx.importedAt,
    });
    return adapt(r);
  },

  cliOptions: [
    {
      flag: '--extract-narratives',
      description:
        'Extract narrative text blocks from C-CDA sections and write a JSON sidecar <file>.narratives.json. Only meaningful when --from c-cda.',
    },
  ],

  async postProcess(input, result, ctx) {
    if (!ctx.options['extractNarratives'] || !result.success) return;

    try {
      const allBlocks: NarrativeBlock[] = [];
      const isZip =
        Buffer.isBuffer(input) && input.length >= 2 && input[0] === 0x50 && input[1] === 0x4b;

      if (isZip) {
        const zip = new AdmZip(input as Buffer);
        const xmlEntries = zip
          .getEntries()
          .filter((e) => !e.isDirectory && e.entryName.toUpperCase().endsWith('.XML'));
        for (const entry of xmlEntries) {
          try {
            const xml = entry.getData().toString('utf-8');
            const parsedDoc = parseCcdaXml(xml);
            const blocks = collectNarrativeBlocks(parsedDoc);
            allBlocks.push(...blocks);
          } catch {
            // Skip unparseable entries — partial results are still useful.
          }
        }
      } else {
        const xml = Buffer.isBuffer(input) ? input.toString('utf-8') : input;
        const parsedDoc = parseCcdaXml(xml);
        allBlocks.push(...collectNarrativeBlocks(parsedDoc));
      }

      const narrativesPath =
        ctx.inputPath !== '<stdin>'
          ? join(dirname(ctx.inputPath), `${basename(ctx.inputPath)}.narratives.json`)
          : 'ccda-narratives.json';

      writeFileSync(narrativesPath, JSON.stringify(allBlocks, null, 2));
      console.error(
        `Narrative blocks written to: ${narrativesPath} (${allBlocks.length} blocks)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Warning: Failed to extract narratives: ${msg}`);
    }
  },
};
