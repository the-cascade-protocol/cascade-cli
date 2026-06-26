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
import type { ExpandedSource, SkippedArtifact, SourceAdapter } from './types.js';

const CLINICAL_DIR = 'clinical-records';
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

    const clinicalDir = path.join(targetPath, CLINICAL_DIR);
    if (isDir(clinicalDir)) {
      for (const name of fs.readdirSync(clinicalDir)) {
        if (name.toLowerCase().endsWith('.json')) {
          files.push(path.join(clinicalDir, name));
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

    return { files, skipped, sourceLabel: 'Apple Health export' };
  },
};
