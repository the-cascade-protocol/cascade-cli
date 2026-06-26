/**
 * Generic directory source adapter: the catch-all for "a folder of files."
 *
 * Recursively collects every supported file (FHIR JSON, Turtle, C-CDA XML, IHE
 * XDM zip) under a directory and hands them to the per-file import path. This is
 * what makes "import this folder of records" work for any layout that is not a
 * recognized vendor export.
 *
 * It also guards the whole-file read limit: a file larger than ~2 GiB cannot be
 * read whole by the current importer (Node's fs.readFile cap), so rather than
 * letting it blow up mid-import, the adapter SKIPS it with a clear reason. When
 * streaming converters land, this guard is where they take over.
 *
 * Registered AFTER more specific adapters (e.g. Apple Health), so a recognized
 * export is handled by its own adapter and only an unrecognized folder falls
 * through to here.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ExpandedSource, SkippedArtifact, SourceAdapter } from './types.js';

/** Extensions the per-file import path understands. */
const SUPPORTED_EXT = new Set(['.json', '.ttl', '.xml', '.zip']);

/**
 * Whole-file read ceiling. Node's fs.readFile throws above 2 GiB
 * (2,147,483,647 bytes); we stay just under to skip gracefully instead of
 * failing. Streaming import will lift this.
 */
const MAX_WHOLE_FILE_BYTES = 2_000_000_000;

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export const directoryAdapter: SourceAdapter = {
  id: 'directory',
  description: 'A folder of supported files (FHIR JSON, Turtle, C-CDA XML or IHE XDM zip)',

  detect(targetPath: string): boolean {
    return isDir(targetPath);
  },

  expand(targetPath: string): ExpandedSource {
    const files: string[] = [];
    const skipped: SkippedArtifact[] = [];

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue; // skip dotfiles / .DS_Store
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
          continue;
        }
        if (!SUPPORTED_EXT.has(path.extname(ent.name).toLowerCase())) continue;
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          continue;
        }
        if (size > MAX_WHOLE_FILE_BYTES) {
          skipped.push({
            path: full,
            reason: `${(size / 1e9).toFixed(1)} GB exceeds the whole-file import limit; streaming import not yet supported`,
          });
          continue;
        }
        files.push(full);
      }
    };
    walk(targetPath);

    return { files, skipped, sourceLabel: 'folder' };
  },
};
