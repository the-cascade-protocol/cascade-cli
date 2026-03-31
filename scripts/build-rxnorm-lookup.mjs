#!/usr/bin/env node
/**
 * Build a compact RxNorm name lookup table from the standalone RxNorm release.
 *
 * RxNorm is a US federal government product and its core vocabulary (SAB=RXNORM)
 * is in the public domain. Required attribution:
 *   "This product uses publicly available data courtesy of the U.S. National
 *    Library of Medicine (NLM), National Institutes of Health, Department of
 *    Health and Human Services; NLM is not responsible for the product and does
 *    not endorse or recommend this or any other product."
 *
 * Usage:
 *   node scripts/build-rxnorm-lookup.mjs <path-to-rxnorm-rrf-dir>
 *
 * Where <path-to-rxnorm-rrf-dir> is the directory containing RXNCONSO.RRF from
 * the standalone RxNorm Full Release download:
 *   https://www.nlm.nih.gov/research/umls/rxnorm/docs/rxnormfiles.html
 *
 * Output: src/data/rxnorm-names.json  (rxcui → generic ingredient name)
 *
 * Filters applied:
 *   SAB=RXNORM  — core RxNorm vocabulary only (public domain, SRL=0)
 *   TTY=IN      — ingredient (generic name)
 *   SUPPRESS=N  — active, non-suppressed entries only
 */

import { createReadStream, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const rfrDir = process.argv[2];
if (!rfrDir) {
  console.error('Usage: node scripts/build-rxnorm-lookup.mjs <path-to-rxnorm-rrf-dir>');
  console.error('');
  console.error('Download the RxNorm Full Release from:');
  console.error('  https://www.nlm.nih.gov/research/umls/rxnorm/docs/rxnormfiles.html');
  console.error('Extract the zip and pass the directory containing RXNCONSO.RRF.');
  process.exit(1);
}

const rrf = join(rfrDir, 'RXNCONSO.RRF');
if (!existsSync(rrf)) {
  console.error(`Error: RXNCONSO.RRF not found in ${rfrDir}`);
  process.exit(1);
}

// RXNCONSO.RRF column indices (pipe-delimited, no header row):
// 0  RXCUI  | 1  LAT  | 2  TS  | 3  LUI  | 4  STT  | 5  SUI  | 6  ISPREF
// 7  RXAUI  | 8  SAUI | 9  SCUI | 10 SDUI | 11 SAB  | 12 TTY  | 13 CODE
// 14 STR    | 15 SRL  | 16 SUPPRESS | 17 CVF
const COL_RXCUI    = 0;
const COL_SAB      = 11;
const COL_TTY      = 12;
const COL_STR      = 14;
const COL_SUPPRESS = 16;

const lookup = {};
let total = 0;

const rl = createInterface({
  input: createReadStream(rrf, { encoding: 'utf-8' }),
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  const cols = line.split('|');
  if (
    cols[COL_SAB]      === 'RXNORM' &&
    cols[COL_TTY]      === 'IN'     &&
    cols[COL_SUPPRESS] === 'N'
  ) {
    lookup[cols[COL_RXCUI]] = cols[COL_STR];
    total++;
  }
});

rl.on('close', () => {
  const outDir = join(__dirname, '../src/data');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'rxnorm-names.json');
  writeFileSync(outPath, JSON.stringify(lookup));
  console.log(`✓ ${total.toLocaleString()} RxNorm ingredient entries written to src/data/rxnorm-names.json`);
  console.log('');
  console.log('Run `npm run build` to include the lookup in the dist package.');
});
