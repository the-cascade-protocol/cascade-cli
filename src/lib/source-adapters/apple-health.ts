/**
 * Apple Health export source adapter.
 *
 * An unzipped Apple Health export is a folder containing:
 *   - export.xml        (the device firehose: years of heart-rate/step samples)
 *   - export_cda.xml    (a CDA rendering of the same, also multi-GB)
 *   - clinical-records/ (the GOLD: per-resource FHIR JSON synced from the user's
 *                        providers — conditions, meds, labs, immunizations, ...)
 *   - electrocardiograms/, workout-routes/ (device data)
 *
 * The clinical-records FHIR files are small and the existing FHIR importer
 * already converts them. The two giant XMLs are device time-series, over Node's
 * whole-file read limit, and not the clinical data a user is usually after. So
 * this adapter imports clinical-records and SKIPS the device exports with a clear
 * reason (rather than failing on a 2.3 GB read). Streaming import of the device
 * series is a later slice; when it lands, this adapter starts yielding it too.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ExpandedSource, FileSourceMeta, SkippedArtifact, SourceAdapter } from './types.js';

const CLINICAL_DIR = 'clinical-records';
/** The primary device export Apple writes at the export root (the firehose). */
const PRIMARY_EXPORT = 'export.xml';
/** The multi-GB device exports Apple writes at the export root. */
const DEVICE_EXPORTS = ['export.xml', 'export_cda.xml'];
/** Other non-clinical device-data folders. */
const DEVICE_DIRS = ['electrocardiograms', 'workout-routes'];

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sizeGB(p: string): string {
  try {
    return (fs.statSync(p).size / 1e9).toFixed(1);
  } catch {
    return '?';
  }
}

/** Minimal XML entity decode for attribute values (sourceName carries `&amp;`). */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

/** Read a single attribute value out of one element's opening tag. */
function readAttr(element: string, name: string): string | undefined {
  const m = new RegExp(`${name}="([^"]*)"`).exec(element);
  return m ? m[1] : undefined;
}

/**
 * Recover Apple's per-record source labels from export.xml's `<ClinicalRecord>`
 * wrappers, keyed by the clinical-records JSON filename (basename of
 * resourceFilePath).
 *
 * export.xml is the device firehose (multi-GB) and is otherwise skipped, but the
 * `<ClinicalRecord ... />` elements are a small block at the very END of the file
 * (after the millions of `<Record>` HealthKit samples). So we never read the
 * whole file: we read a bounded window off the TAIL, growing it only if the
 * expected number of wrappers is not yet present. Each wrapper carries the
 * authoritative `sourceName` (e.g. "Providence Health & Services") that the FHIR
 * payloads themselves often lack. A partial element at the window's leading edge
 * simply fails the full-element regex and is recovered when the window grows.
 */
function readClinicalRecordSources(
  exportXmlPath: string,
  expectedCount: number,
): Map<string, FileSourceMeta> {
  const byFilename = new Map<string, FileSourceMeta>();
  let fd: number;
  try {
    fd = fs.openSync(exportXmlPath, 'r');
  } catch {
    return byFilename;
  }
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize === 0) return byFilename;
    const MAX_WINDOW = 64 * 1024 * 1024; // cap the tail read; the block is ~1 byte/record
    let window = Math.min(fileSize, 2 * 1024 * 1024);
    let text = '';
    for (;;) {
      const start = Math.max(0, fileSize - window);
      const length = fileSize - start;
      const buf = Buffer.allocUnsafe(length);
      fs.readSync(fd, buf, 0, length, start);
      text = buf.toString('utf-8');
      const seen = (text.match(/<ClinicalRecord\b/g) ?? []).length;
      if (seen >= expectedCount || start === 0 || window >= MAX_WINDOW) break;
      window = Math.min(window * 2, MAX_WINDOW, fileSize);
    }
    const elementRe = /<ClinicalRecord\b[^>]*?\/>/g;
    let m: RegExpExecArray | null;
    while ((m = elementRe.exec(text)) !== null) {
      const el = m[0];
      const rfp = readAttr(el, 'resourceFilePath');
      if (!rfp) continue;
      const filename = rfp.split('/').pop();
      if (!filename) continue;
      const sourceName = readAttr(el, 'sourceName');
      const sourceUrl = readAttr(el, 'sourceURL');
      const receivedDate = readAttr(el, 'receivedDate');
      byFilename.set(filename, {
        sourceEhr: sourceName ? decodeXmlEntities(sourceName) : undefined,
        sourceUrl: sourceUrl ? decodeXmlEntities(sourceUrl) : undefined,
        receivedDate,
      });
    }
  } catch {
    // Best-effort: a parse/read failure just means no per-record source labels;
    // conversion falls back to per-resource derivation. Never fatal to import.
  } finally {
    fs.closeSync(fd);
  }
  return byFilename;
}

export const appleHealthAdapter: SourceAdapter = {
  id: 'apple-health',
  description:
    'Apple Health export folder (imports clinical-records FHIR; device exports skipped pending streaming import)',

  detect(targetPath: string): boolean {
    if (!isDir(targetPath)) return false;
    // Signature: the device export XML(s) and/or the clinical-records folder.
    const hasDeviceExport = DEVICE_EXPORTS.some((f) =>
      fs.existsSync(path.join(targetPath, f)),
    );
    return hasDeviceExport || isDir(path.join(targetPath, CLINICAL_DIR));
  },

  expand(targetPath: string): ExpandedSource {
    const files: string[] = [];
    const skipped: SkippedArtifact[] = [];
    const fileSources: Record<string, FileSourceMeta> = {};

    const clinicalDir = path.join(targetPath, CLINICAL_DIR);
    const clinicalNames: string[] = [];
    if (isDir(clinicalDir)) {
      for (const name of fs.readdirSync(clinicalDir)) {
        if (name.toLowerCase().endsWith('.json')) {
          files.push(path.join(clinicalDir, name));
          clinicalNames.push(name);
        }
      }
    }

    // Recover the authoritative per-record source (the Apple account) from
    // export.xml's <ClinicalRecord> wrappers and attach it by absolute path. The
    // device firehose itself is still skipped below; we only read its tail block.
    const exportXmlPath = path.join(targetPath, PRIMARY_EXPORT);
    if (clinicalNames.length > 0 && fs.existsSync(exportXmlPath)) {
      const byFilename = readClinicalRecordSources(exportXmlPath, clinicalNames.length);
      for (const name of clinicalNames) {
        const meta = byFilename.get(name);
        if (meta && (meta.sourceEhr || meta.sourceUrl || meta.receivedDate)) {
          fileSources[path.join(clinicalDir, name)] = meta;
        }
      }
    }

    for (const f of DEVICE_EXPORTS) {
      const p = path.join(targetPath, f);
      if (fs.existsSync(p)) {
        skipped.push({
          path: p,
          reason: `Apple Health device export (${sizeGB(p)} GB of time-series); streaming import not yet supported`,
        });
      }
    }
    for (const d of DEVICE_DIRS) {
      const p = path.join(targetPath, d);
      if (isDir(p)) {
        skipped.push({ path: p, reason: 'device data (ECG / workout routes), not clinical records' });
      }
    }

    return { files, skipped, sourceLabel: 'Apple Health export', fileSources };
  },
};
