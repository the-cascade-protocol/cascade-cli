/**
 * IHE XDM source adapter: an UNZIPPED "Download My Record" export (Epic MyChart,
 * Cerner, etc.). The media layout is a folder containing an `IHE_XDM/` directory
 * with one submission-set subfolder per export, each holding:
 *   - METADATA.XML    the ebXML SubmitObjectsRequest manifest (NOT a clinical doc)
 *   - DOC0001.XML ...  the actual C-CDA ClinicalDocument(s)
 *   - STYLE.XSL        a rendering stylesheet
 * plus, at the package root, a rendered HTML view, a PDF, INDEX.HTM, and a README.
 *
 * The per-file importer converts C-CDA, but feeding it METADATA.XML (ebXML, not
 * CDA) produces no output and used to abort the whole import. This adapter
 * recognizes the XDM layout and yields ONLY the C-CDA documents, skipping the
 * manifest and the non-clinical rendering files with clear reasons; the existing
 * C-CDA converter (with its Epic/Cerner vendor normalization) does the rest.
 *
 * Classification is by CONTENT, not filename, so it is robust to vendor naming:
 * an XML whose root is <ClinicalDocument> is a document; one whose root is
 * <SubmitObjectsRequest> / <ProvideAndRegister...> is the manifest.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ExpandedSource, SkippedArtifact, SourceAdapter } from './types.js';

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Read the first ~2 KB of a file as text (enough to see the XML root element). */
function peekHead(p: string): string {
  let fd: number;
  try {
    fd = fs.openSync(p, 'r');
  } catch {
    return '';
  }
  try {
    const buf = Buffer.allocUnsafe(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    return buf.toString('utf-8', 0, n);
  } catch {
    return '';
  } finally {
    fs.closeSync(fd);
  }
}

const CDA_ROOT = /<ClinicalDocument[\s>]/i;
const XDM_MANIFEST = /<(?:[a-z0-9]+:)?(?:SubmitObjectsRequest|ProvideAndRegisterDocumentSetRequest)[\s>]/i;

/** True iff this folder looks like an unzipped IHE XDM media export. */
function looksLikeXdm(targetPath: string): boolean {
  if (!isDir(targetPath)) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(targetPath, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    // An IHE_XDM/ container folder, or a submission-set folder holding METADATA.XML.
    if (e.isDirectory() && e.name.toUpperCase() === 'IHE_XDM') return true;
    if (e.isFile() && e.name.toUpperCase() === 'METADATA.XML') return true;
  }
  return false;
}

export const iheXdmAdapter: SourceAdapter = {
  id: 'ihe-xdm',
  description:
    'Unzipped IHE XDM export folder (Epic MyChart / Cerner "Download My Record")',

  detect(targetPath: string): boolean {
    return looksLikeXdm(targetPath);
  },

  expand(targetPath: string): ExpandedSource {
    const files: string[] = [];
    const skipped: SkippedArtifact[] = [];
    let nonClinical = 0;

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
          continue;
        }
        if (path.extname(ent.name).toLowerCase() !== '.xml') {
          nonClinical += 1; // PDF, INDEX.HTM, STYLE.XSL, README.TXT, png, css...
          continue;
        }
        const head = peekHead(full);
        if (CDA_ROOT.test(head)) {
          files.push(full);
        } else if (XDM_MANIFEST.test(head)) {
          skipped.push({
            path: full,
            reason: 'IHE XDM submission manifest (not a clinical document)',
          });
        } else {
          skipped.push({ path: full, reason: 'XML is not a C-CDA ClinicalDocument' });
        }
      }
    };
    walk(targetPath);

    if (nonClinical > 0) {
      skipped.push({
        path: targetPath,
        reason: `${nonClinical} non-clinical file(s) (rendered HTML, PDF, stylesheet, images)`,
      });
    }

    return { files, skipped, sourceLabel: 'Clinical document export (IHE XDM)' };
  },
};
