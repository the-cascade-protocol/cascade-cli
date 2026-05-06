/**
 * VCF header parser.
 *
 * Parses the buffered `##` and `#CHROM` lines into a structured
 * VcfHeader. Extracts:
 *
 *   ##fileformat=VCFv4.X       — validated to v4.0+
 *   ##reference=<text>         — referenceGenome (e.g., GRCh38, hg19)
 *   ##contig=<ID=...,length=N> — informational; recorded keyed by ID
 *   ##INFO=<ID=...,...>        — INFO field schema
 *   ##FORMAT=<ID=...,...>      — FORMAT field schema
 *   ##SAMPLE=<ID=...,...>      — sample-level metadata
 *   ##source=<text>            — variant caller / pipeline source
 *   ##fileDate=<text>          — ISO 8601 or YYYYMMDD
 *   #CHROM\tPOS\t...           — column header; sample names taken from
 *                                everything after FORMAT
 *
 * Structured `<ID=...,foo=bar,Description="quoted text">` parsing handles
 * commas and quoted values per VCF v4.x spec.
 */

import type { VcfFieldMeta, VcfHeader, VcfSourceProfile } from './types.js';

const SIMPLE_KV_RE = /^##([^=]+)=(.+)$/;
const STRUCTURED_RE = /^<(.*)>$/;

/**
 * Parse a structured VCF metadata payload like
 *   <ID=DP,Number=1,Type=Integer,Description="Total Depth">
 *
 * Returns a Map of key → string value. Quoted strings are unquoted. Commas
 * inside quoted Description fields don't terminate fields. Order-sensitive
 * is not required — VCF spec guarantees ID is first but consumers don't
 * rely on it.
 */
function parseStructuredFields(payload: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  const n = payload.length;
  while (i < n) {
    // skip leading commas / whitespace
    while (i < n && (payload[i] === ',' || payload[i] === ' ')) i++;
    if (i >= n) break;

    // read key
    const keyStart = i;
    while (i < n && payload[i] !== '=') i++;
    if (i >= n) {
      // dangling key with no value — record it as flag
      const orphan = payload.slice(keyStart).trim();
      if (orphan.length > 0) fields[orphan] = '';
      break;
    }
    const key = payload.slice(keyStart, i).trim();
    i++; // skip '='

    // read value, possibly quoted
    let value: string;
    if (i < n && payload[i] === '"') {
      i++; // skip opening quote
      const valStart = i;
      while (i < n && payload[i] !== '"') {
        // crude quote-escape support (VCF spec uses \" inside Description)
        if (payload[i] === '\\' && i + 1 < n) i += 2;
        else i++;
      }
      value = payload.slice(valStart, i).replace(/\\"/g, '"');
      if (i < n && payload[i] === '"') i++; // skip closing quote
    } else {
      const valStart = i;
      while (i < n && payload[i] !== ',') i++;
      value = payload.slice(valStart, i).trim();
    }
    fields[key] = value;
  }
  return fields;
}

function asFieldMeta(record: Record<string, string>): VcfFieldMeta {
  const meta: VcfFieldMeta = {};
  if ('Number' in record) {
    const n = record.Number;
    // Number can be: integer, '.', 'A', 'R', 'G' — preserve as string when not integer.
    const asInt = Number(n);
    meta.Number = Number.isFinite(asInt) && /^-?\d+$/.test(n) ? asInt : n;
  }
  if ('Type' in record) meta.Type = record.Type;
  if ('Description' in record) meta.Description = record.Description;
  return meta;
}

/**
 * Validate that the file format is one of v4.0+. Throws on missing or
 * pre-v4 headers — those formats predate the structured-INFO design and
 * aren't supported.
 */
function validateFileFormat(fileFormat: string): void {
  if (!fileFormat) {
    throw new Error('VCF header missing ##fileformat= line');
  }
  const m = /^VCFv(\d+)\.(\d+)$/i.exec(fileFormat);
  if (!m) {
    throw new Error(`VCF header has unrecognized fileformat "${fileFormat}"; expected VCFv4.X`);
  }
  const major = parseInt(m[1], 10);
  if (major < 4) {
    throw new Error(`VCF v${m[1]}.${m[2]} is not supported; minimum is v4.0`);
  }
}

/**
 * Parse the buffered `##` and `#CHROM` header lines into a VcfHeader.
 * Throws on missing or unsupported ##fileformat — caller surfaces as a
 * conversion error.
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

      // Top-level scalar keys.
      if (key === 'reference') {
        header.reference = value;
        continue;
      }
      if (key === 'fileDate') {
        header.fileDate = value;
        continue;
      }
      if (key === 'source') {
        header.source = value;
        continue;
      }

      // Structured payloads: <key=value,...>
      const sm = STRUCTURED_RE.exec(value);
      if (sm) {
        const fields = parseStructuredFields(sm[1]);
        const id = fields.ID;

        if (key === 'INFO' && id) {
          header.info.set(id, asFieldMeta(fields));
        } else if (key === 'FORMAT' && id) {
          header.format.set(id, asFieldMeta(fields));
        } else if (key === 'contig' && id) {
          const len = fields.length;
          const lenN = len ? parseInt(len, 10) : NaN;
          header.contigs.set(id, {
            length: Number.isFinite(lenN) ? lenN : undefined,
            assembly: fields.assembly,
          });
        } else if (key === 'SAMPLE' && id) {
          header.samples.set(id, fields);
        }
      }
      continue;
    }

    if (line.startsWith('#CHROM')) {
      // Column header. VCF requires at minimum:
      //   #CHROM POS ID REF ALT QUAL FILTER INFO
      // Optional FORMAT + per-sample columns:
      //   #CHROM POS ID REF ALT QUAL FILTER INFO FORMAT sample1 sample2 ...
      const cols = line.slice(1).split('\t');
      const fmtIdx = cols.indexOf('FORMAT');
      if (fmtIdx >= 0 && cols.length > fmtIdx + 1) {
        header.sampleColumns = cols.slice(fmtIdx + 1);
      }
    }
  }

  validateFileFormat(header.fileFormat);
  return header;
}

/**
 * Classify the VCF source for the D-QUALITY-TIER heuristic. ClinVar's
 * weekly export is curated and aggregated from clinical submissions, so it
 * earns ClinicalGrade by default — anything else is ResearchGrade.
 *
 * The heuristic is intentionally narrow: only an exact ClinVar mention
 * promotes the tier. Production importers may broaden this (e.g. recognized
 * CLIA-certified pipelines) once the trusted-issuer registry exists.
 */
export function classifySource(header: VcfHeader): VcfSourceProfile {
  const sourceLower = (header.source ?? '').trim().toLowerCase();
  return {
    sourceLower,
    isClinvarLike: sourceLower.includes('clinvar'),
  };
}
