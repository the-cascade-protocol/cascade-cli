#!/usr/bin/env node
/**
 * check-knowledge-drift.mjs — fail when the vendored medication status tables
 * no longer match `cascade-knowledge`.
 *
 * INDEPENDENCE. Like check-shapes-drift.mjs, this does not read, import or share
 * a list with the generator (sync-knowledge-from-cascade-knowledge.mjs). Both
 * sides are DISCOVERED:
 *   - what upstream publishes -> every `data/medication-status-*.jsonl` in the
 *     cascade-knowledge checkout (a readdir, not a list)
 *   - what this repo vendors  -> every family key in the snapshot
 * and drift is any disagreement, in either direction.
 *
 * ASSERTS
 *   1. The two family sets are equal.
 *   2. For each family, the vendored lines, joined, are byte-equal to the
 *      upstream file (compared as bytes, not as parsed rows).
 *   3. The vendored sha256 is the hash of those bytes AND the one upstream's
 *      data/BUILD_MANIFEST.json records, and the row count agrees.
 *
 * NOT FINDING ANYTHING IS NOT A PASS: fewer than two upstream families, or an
 * empty family, exits 2.
 *
 * EXIT CODES: 0 match; 1 drift; 2 cannot check (no checkout, unreadable input,
 * vacuous walk). 2 is never conflated with 0.
 *
 * USAGE
 *   node scripts/check-knowledge-drift.mjs [--knowledge <dir>]
 *   CASCADE_KNOWLEDGE_DIR=/path node scripts/check-knowledge-drift.mjs
 * Resolution order: --knowledge, then CASCADE_KNOWLEDGE_DIR, then ../cascade-knowledge.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = join(ROOT, 'src', 'knowledge', 'medication-status.snapshot.json');
const PREFIX = 'medication-status-';
const MIN_FAMILIES = 2;

function cannot(msg) {
  process.stderr.write(`check-knowledge-drift: CANNOT CHECK: ${msg}\n`);
  process.exit(2);
}

function knowledgeDir() {
  const i = process.argv.indexOf('--knowledge');
  if (i !== -1 && process.argv[i + 1]) return resolve(process.argv[i + 1]);
  if (process.env.CASCADE_KNOWLEDGE_DIR) return resolve(process.env.CASCADE_KNOWLEDGE_DIR);
  return resolve(ROOT, '..', 'cascade-knowledge');
}

let dir = knowledgeDir();
if (!existsSync(join(dir, 'data'))) cannot(`no cascade-knowledge checkout at ${dir}`);
// readdir through a symlinked start point is fine, but resolve it anyway so the
// reported path is the real one.
dir = realpathSync(dir);
const dataDir = join(dir, 'data');

const upstream = readdirSync(dataDir)
  .filter((f) => f.startsWith(PREFIX) && f.endsWith('.jsonl'))
  .map((f) => f.slice(0, -'.jsonl'.length))
  .sort();
if (upstream.length < MIN_FAMILIES) {
  cannot(`found ${upstream.length} ${PREFIX}* families in ${dataDir}, expected at least ${MIN_FAMILIES}`);
}

if (!existsSync(SNAPSHOT)) cannot(`no vendored snapshot at ${SNAPSHOT}`);
let snapshot;
let manifest;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  manifest = JSON.parse(readFileSync(join(dataDir, 'BUILD_MANIFEST.json'), 'utf8'));
} catch (e) {
  cannot(e.message);
}
const vendored = Object.keys(snapshot.families ?? {}).sort();

const drift = [];
for (const f of upstream) if (!vendored.includes(f)) drift.push(`${f}: published upstream, not vendored`);
for (const f of vendored) if (!upstream.includes(f)) drift.push(`${f}: vendored, not published upstream`);

for (const f of vendored.filter((v) => upstream.includes(v))) {
  const fam = snapshot.families[f];
  if (!Array.isArray(fam.lines) || fam.lines.length === 0) cannot(`${f}: vendored family has no lines`);
  const up = readFileSync(join(dataDir, `${f}.jsonl`));
  const mine = Buffer.from(fam.lines.join('\n') + '\n', 'utf8');
  if (!up.equals(mine)) drift.push(`${f}: vendored bytes differ from upstream`);
  const sha = createHash('sha256').update(mine).digest('hex');
  if (fam.sha256 !== sha) drift.push(`${f}: recorded sha256 ${fam.sha256} is not the hash of the vendored lines (${sha})`);
  const m = manifest.files?.[`${f}.jsonl`];
  if (!m) drift.push(`${f}: absent from upstream BUILD_MANIFEST`);
  else {
    if (m.sha256 !== sha) drift.push(`${f}: upstream manifest sha256 ${m.sha256} != vendored ${sha}`);
    if (m.rows !== fam.lines.length || fam.rows !== fam.lines.length) {
      drift.push(`${f}: row counts disagree (manifest ${m.rows}, recorded ${fam.rows}, lines ${fam.lines.length})`);
    }
  }
}

if (drift.length) {
  process.stderr.write(`check-knowledge-drift: DRIFT against ${dir}\n`);
  for (const d of drift) process.stderr.write(`  ${d}\n`);
  process.stderr.write('Run: node scripts/sync-knowledge-from-cascade-knowledge.mjs\n');
  process.exit(1);
}
process.stdout.write(`check-knowledge-drift: ${vendored.length} families match ${dir}\n`);
