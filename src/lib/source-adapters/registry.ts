/**
 * Source-adapter registry: the container layer's dispatch.
 *
 * `pod import` runs each directory input through `detectSource` to find the
 * adapter that expands it into importable files. Order is significant: more
 * specific adapters (a recognized vendor export) come before the generic
 * directory catch-all, and the first match wins.
 *
 * Adding a new container shape (a new vendor export, a tarball, a portal
 * download bundle) is a one-line edit here plus an adapter file, mirroring the
 * FormatImporter registry pattern.
 */

import { appleHealthAdapter } from './apple-health.js';
import { directoryAdapter } from './directory.js';
import type { SourceAdapter } from './types.js';

/** Registered source adapters, most specific first. */
export const sourceAdapters: ReadonlyArray<SourceAdapter> = [
  appleHealthAdapter,
  directoryAdapter, // catch-all: any other folder
];

/** The first adapter that handles `targetPath`, or undefined. Never throws. */
export function detectSource(targetPath: string): SourceAdapter | undefined {
  return sourceAdapters.find((a) => {
    try {
      return a.detect(targetPath);
    } catch {
      return false;
    }
  });
}

export type { SourceAdapter, ExpandedSource, SkippedArtifact } from './types.js';
