#!/usr/bin/env node
/**
 * Deterministically split a FHIR Bundle into a one-resource-per-file layout
 * (the Apple Health clinical-records export shape) so a single-bundle corpus can
 * be exercised through the multi-file import path.
 *
 * `cascade pod import` resolves cross-record reference edges ONCE per import
 * invocation (root backlog 2.11, slice R5). A single Bundle resolves everything
 * in-batch; an Apple Health export is one resource per file, so the same edges
 * must resolve across files. This splitter turns a Bundle into that layout, which
 * lets a test assert the two layouts are equivalent (root backlog 3.22).
 *
 * The split is byte-deterministic: entries are emitted in bundle order, each file
 * is named `<ResourceType>-<id>.json`, and each holds the bare resource
 * pretty-printed with two-space indentation. Given the same input Bundle the
 * output directory is identical every run.
 *
 * Usage:
 *   node scripts/2026-07-23-split-fhir-bundle.mjs <bundle.json> <output-dir>
 *
 * The output directory is created if absent. Existing `*.json` files in it are
 * removed first so a re-split never leaves stale resources behind.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';

/**
 * Split a parsed FHIR Bundle object into one bare-resource file per entry.
 * Returns the list of written basenames in emission order.
 *
 * @param {{ resourceType?: string, entry?: Array<{ resource?: any }> }} bundle
 * @param {string} outDir
 * @returns {string[]}
 */
export function splitBundle(bundle, outDir) {
  if (!bundle || bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry)) {
    throw new Error('Input is not a FHIR Bundle with an entry array');
  }

  mkdirSync(outDir, { recursive: true });
  // Clear any prior split so re-running is idempotent (never leaves stale files).
  for (const existing of readdirSync(outDir)) {
    if (existing.endsWith('.json')) rmSync(join(outDir, existing));
  }

  const written = [];
  const usedNames = new Set();

  for (const entry of bundle.entry) {
    const resource = entry?.resource;
    if (!resource || typeof resource !== 'object') continue;
    const type = resource.resourceType;
    const id = resource.id;
    if (!type || id === undefined || id === null) {
      throw new Error(
        `Bundle entry is missing resourceType or id: ${JSON.stringify(resource).slice(0, 120)}`,
      );
    }

    // Filesystem-safe basename. Synthea ids are UUIDs, but guard anyway so the
    // split is total for any Bundle.
    const safeId = String(id).replace(/[^A-Za-z0-9._-]/g, '_');
    let base = `${type}-${safeId}`;
    // Defend against a post-sanitization collision (distinct ids that map to the
    // same safe form) so no resource is silently overwritten.
    let name = `${base}.json`;
    let n = 2;
    while (usedNames.has(name)) {
      name = `${base}-${n}.json`;
      n += 1;
    }
    usedNames.add(name);

    writeFileSync(join(outDir, name), JSON.stringify(resource, null, 2) + '\n');
    written.push(name);
  }

  return written;
}

// --- CLI entry point (only when run directly, not when imported by a test) ---
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [, , bundlePath, outDir] = process.argv;
  if (!bundlePath || !outDir) {
    console.error('Usage: node scripts/2026-07-23-split-fhir-bundle.mjs <bundle.json> <output-dir>');
    process.exit(1);
  }
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf-8'));
  const written = splitBundle(bundle, outDir);
  console.error(`Split ${written.length} resource(s) into ${outDir}`);
}
