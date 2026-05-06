/**
 * VCF header parser.
 *
 * Stub at TASK-3A.1 — full implementation lands in TASK-3A.2.
 * Currently extracts only fileformat, reference, fileDate, and source so the
 * orchestrator + registry-entry compile and detect.ts can be tested
 * end-to-end.
 *
 * TASK-3A.2 fills in:
 *   - structured ##INFO=<ID=...>, ##FORMAT=<ID=...>, ##contig=<...>,
 *     ##SAMPLE=<...>, plus the column header line parsed for sample names.
 *   - validation that fileformat is v4.0+.
 */

import type { VcfHeader, VcfSourceProfile } from './types.js';

const SIMPLE_KV_RE = /^##([^=]+)=(.+)$/;

/**
 * Parse the buffered `##` and `#CHROM` header lines into a VcfHeader.
 * Empty implementation at TASK-3A.1; TASK-3A.2 fleshes it out.
 */
export function parseHeaderLines(lines: string[]): VcfHeader {
  const header: VcfHeader = {
    fileFormat: '',
    contigs: new Map(),
    info: new Map(),
    format: new Map(),
    samples: new Map(),
    sampleColumns: [],
    rawHeader: lines.join('\n'),
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    if (line.startsWith('##fileformat=')) {
      header.fileFormat = line.slice('##fileformat='.length).trim();
      continue;
    }

    if (line.startsWith('##')) {
      const m = SIMPLE_KV_RE.exec(line);
      if (!m) continue;
      const key = m[1];
      const value = m[2];

      // Simple top-level keys (placeholder; TASK-3A.2 expands to structured forms).
      if (key === 'reference') header.reference = value;
      else if (key === 'fileDate') header.fileDate = value;
      else if (key === 'source') header.source = value;
      continue;
    }

    if (line.startsWith('#CHROM')) {
      // Column header — split out sample columns (everything after FORMAT).
      const cols = line.slice(1).split('\t');
      const fmtIdx = cols.indexOf('FORMAT');
      if (fmtIdx >= 0 && cols.length > fmtIdx + 1) {
        header.sampleColumns = cols.slice(fmtIdx + 1);
      }
    }
  }

  return header;
}

/**
 * Classify the VCF source for the D-QUALITY-TIER heuristic. ClinVar's
 * weekly export is curated and aggregated from clinical submissions, so it
 * earns ClinicalGrade by default — anything else is ResearchGrade.
 */
export function classifySource(header: VcfHeader): VcfSourceProfile {
  const sourceLower = (header.source ?? '').trim().toLowerCase();
  return {
    sourceLower,
    isClinvarLike: sourceLower.includes('clinvar'),
  };
}
