#!/usr/bin/env node
/**
 * sync-knowledge-from-cascade-knowledge.mjs — vendor the medication status
 * tables from `cascade-knowledge` into `src/knowledge/medication-status.snapshot.json`.
 *
 * `cascade-knowledge` is the one place the medication status lifecycle table is
 * authored (FHIR R4 medication status code -> active | stopped | unknown |
 * entered-in-error, plus the non-canonical status synonyms). This repository
 * takes no npm dependency on it; it vendors the two JSONL families, the way
 * `src/shapes/` vendors `spec`.
 *
 * WHY A JSON SNAPSHOT AND NOT THE .jsonl FILES THEMSELVES. The table is read at
 * module load by `src/lib/medication-status.ts`, which has to work from `src/`
 * under vitest, from `dist/` under node, AND inside a Bun single-file executable
 * (the desktop sidecar build), where a file read relative to `import.meta.url`
 * resolves into a virtual filesystem and finds nothing. A JSON module import is
 * bundled in all three. So the JSONL lines are carried VERBATIM, one string per
 * line: `lines.join("\n") + "\n"` reproduces the upstream file byte for byte,
 * and its sha256 is the one `cascade-knowledge/data/BUILD_MANIFEST.json`
 * records. Nothing is re-serialized.
 *
 * Usage:
 *   node scripts/sync-knowledge-from-cascade-knowledge.mjs [--knowledge <dir>]
 *   CASCADE_KNOWLEDGE_DIR=/path node scripts/sync-knowledge-from-cascade-knowledge.mjs
 * Resolution order: --knowledge, then CASCADE_KNOWLEDGE_DIR, then ../cascade-knowledge.
 *
 * After running: `npm run check:knowledge-drift`, `npm run build && npm test`,
 * CHANGELOG entry, version bump.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'knowledge', 'medication-status.snapshot.json');

// The families this repository vendors. The drift checker does NOT read this
// list; it discovers what upstream publishes on its own.
const FAMILIES = ['medication-status-lifecycle', 'medication-status-synonym'];

function knowledgeDir() {
  const i = process.argv.indexOf('--knowledge');
  if (i !== -1 && process.argv[i + 1]) return resolve(process.argv[i + 1]);
  if (process.env.CASCADE_KNOWLEDGE_DIR) return resolve(process.env.CASCADE_KNOWLEDGE_DIR);
  return resolve(ROOT, '..', 'cascade-knowledge');
}

const dir = knowledgeDir();
const manifestPath = join(dir, 'data', 'BUILD_MANIFEST.json');
if (!existsSync(manifestPath)) {
  process.stderr.write(`sync-knowledge: no cascade-knowledge checkout at ${dir}\n`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const snapshot = {
  _comment:
    // Repository-neutral on purpose: every consumer that vendors this table
    // writes the same bytes, so two repositories' snapshots can be compared
    // with cmp.
    'GENERATED from cascade-knowledge data/ by this repository\'s knowledge sync script. Do not edit: change the table upstream and re-sync. Each family carries its JSONL lines verbatim; lines.join("\\n") + "\\n" is the upstream file byte for byte and hashes to sha256.',
  source: 'https://github.com/the-cascade-protocol/cascade-knowledge',
  license: 'CC-BY-4.0 (cascade-knowledge data); FHIR R4 codes CC0',
  families: {},
};
for (const name of FAMILIES) {
  const file = `${name}.jsonl`;
  const bytes = readFileSync(join(dir, 'data', file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const entry = manifest.files?.[file];
  if (!entry) {
    process.stderr.write(`sync-knowledge: ${file} is not in the upstream BUILD_MANIFEST\n`);
    process.exit(1);
  }
  if (entry.sha256 !== sha256) {
    process.stderr.write(`sync-knowledge: ${file} sha256 ${sha256} != upstream manifest ${entry.sha256}\n`);
    process.exit(1);
  }
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) {
    process.stderr.write(`sync-knowledge: ${file} does not end in a newline\n`);
    process.exit(1);
  }
  const lines = text.slice(0, -1).split('\n');
  snapshot.families[name] = { rows: lines.length, sha256, lines };
}
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
process.stdout.write(`wrote ${OUT}\n`);
for (const [name, f] of Object.entries(snapshot.families)) {
  process.stdout.write(`  ${name}: ${f.rows} rows, sha256 ${f.sha256}\n`);
}
