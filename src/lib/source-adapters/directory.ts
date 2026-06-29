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
 * Directory names that never hold clinical records but commonly hold thousands
 * of JSON/XML files (build output, package caches, IDE metadata). Descending into
 * them when a user accidentally picks a project or home folder turns a quick
 * import into a long grind, so the walk skips them. Dotfile dirs (.git, .cache,
 * .venv, ...) are already skipped by the leading-dot rule below.
 */
const IGNORED_DIRS = new Set([
  'node_modules', 'bower_components', 'vendor', 'Pods', 'DerivedData',
  'dist', 'build', 'out', 'target', 'bin', 'obj',
  'venv', '__pycache__', 'site-packages',
  'Library', 'AppData',
]);

/**
 * Whole-file read ceiling. Node's fs.readFile throws above 2 GiB
 * (2,147,483,647 bytes); we stay just under to skip gracefully instead of
 * failing. Streaming import will lift this.
 */
const MAX_WHOLE_FILE_BYTES = 2_000_000_000;

/**
 * Aggregate guards for the whole folder. The importer reads every collected file
 * into memory and holds all converted quads at once (no streaming yet), so an
 * accidentally-picked parent/home folder used to walk thousands of files and
 * gigabytes until Node's heap OOM-ed. Past these limits a folder is almost
 * certainly NOT a deliberate record export, so the adapter refuses it (returns no
 * files) with guidance, instead of grinding into an out-of-memory crash. A real
 * Apple Health clinical-records export (~1.3k small JSON) or a MyChart download
 * (a few MB) is far under both.
 */
const MAX_TOTAL_FILES = 20_000;
const MAX_TOTAL_BYTES = 1_000_000_000; // ~1 GB of source across the folder

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
    let totalBytes = 0;
    let overLimit = false;

    const walk = (dir: string): void => {
      if (overLimit) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (overLimit) return;
        if (ent.name.startsWith('.')) continue; // skip dotfiles / .DS_Store
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (IGNORED_DIRS.has(ent.name)) continue; // build/cache/IDE junk, never records
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
        totalBytes += size;
        if (files.length > MAX_TOTAL_FILES || totalBytes > MAX_TOTAL_BYTES) {
          overLimit = true;
          return;
        }
      }
    };
    walk(targetPath);

    if (overLimit) {
      // Too big to be a deliberate record export — refuse rather than read
      // gigabytes into memory and OOM. Return no files so the import reports the
      // reason and stops fast.
      return {
        files: [],
        skipped: [
          {
            path: targetPath,
            reason:
              `this folder is larger than a record export (over ${MAX_TOTAL_FILES.toLocaleString()} files or ` +
              `${(MAX_TOTAL_BYTES / 1e9).toFixed(0)} GB) — choose the specific export folder ` +
              `(the Apple Health export, or the MyChart download), not a parent like Downloads or your home folder`,
          },
          ...skipped,
        ],
        sourceLabel: 'folder',
      };
    }

    return { files, skipped, sourceLabel: 'folder' };
  },
};
