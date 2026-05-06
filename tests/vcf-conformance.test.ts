/**
 * Conformance regression suite for the VCF importer (Phase 3A).
 *
 * For the single ClinVar partial-corpus fixture in
 * `conformance/fixtures/genomics/vcf/`, this test:
 *
 *   1. Runs the importer programmatically (NOT via CLI shell-out — direct
 *      `vcfImporter.convert()` call so vitest stays fast). The input is a
 *      gzipped VCF and is passed as a Buffer.
 *   2. Canonicalizes both the candidate output and the saved
 *      `<id>.expected.ttl` oracle through `riot --output=nq | sort`.
 *   3. Asserts byte-equal n-quads. On failure, the test prints the diff
 *      (first 40 lines) so the breakage is debuggable from the failure log.
 *   4. Reads `<id>.gaps.json` and asserts the importer's emitted
 *      `vocabularyGaps` array (sorted with the same key as the saved
 *      manifest) matches byte-for-byte.
 *
 * Scale note (Phase 3A):
 *   The fixture is a 64KB head of a real ClinVar weekly VCF — ~1725
 *   Variants × ~10 properties each = ~21,891 quads. Canonicalization
 *   round-trips a ~1.6MB Turtle file through riot; the test takes a few
 *   seconds, which is well inside vitest's default timeout.
 *
 * Path resolution: by default the test resolves the conformance fixture
 * directory via the `conformance` symlink in the cascade-cli worktree
 * (mirrors the existing C-CDA + fhir-genomics test pattern). For agents
 * working in a conformance worktree where `<id>.expected.ttl` lives on a
 * feature branch, set `CASCADE_CONFORMANCE_DIR` to override.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { vcfImporter } from '../src/lib/vcf-converter/registry-entry.js';
import type {
  ImportContext,
  VocabularyGap,
} from '../src/lib/import-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_FIXTURES_DIR = path.resolve(
  __dirname,
  '../../conformance/fixtures/genomics/vcf',
);
const RAW_FIXTURES_DIR = process.env.CASCADE_CONFORMANCE_DIR
  ? path.resolve(process.env.CASCADE_CONFORMANCE_DIR, 'fixtures/genomics/vcf')
  : DEFAULT_FIXTURES_DIR;
// Canonicalize via realpath: the VCF importer hashes ImportContext.inputPath
// into derived IRIs (SequencingRun, prov:wasGeneratedBy back-references), so
// the test must pass the same canonical path the oracle was authored against
// regardless of which symlink chain the test process traversed (~/Development
// is a symlink to ~/Documents/Development on dev machines).
const FIXTURES_DIR = (() => {
  try { return realpathSync(RAW_FIXTURES_DIR); } catch { return RAW_FIXTURES_DIR; }
})();

const FIXTURES = [
  {
    id: 'sample-clinvar',
    /** Gzipped VCF — the importer transparently inflates Buffer input. */
    inputName: 'sample-clinvar.input.vcf.gz',
  },
];

const CTX_BASE: ImportContext = {
  inputPath: '<conformance>',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: {},
};

/**
 * Canonicalize a Turtle string by:
 *   1. Writing it to a temp file
 *   2. Running `riot --output=nq` against it
 *   3. Sorting the n-quads alphabetically
 *
 * `riot` is part of Apache Jena, which is the canonical SHACL/RDF
 * toolchain in the workspace (used by `npm run validate-fixtures`,
 * SHACL conformance, etc.). The byte-equal n-quads serialization is
 * the only stable round-trip target since Turtle prefixes / blank-node
 * naming / triple ordering are parser-dependent.
 */
function canonicalizeTurtle(turtle: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vcf-canon-'));
  const file = path.join(dir, 'in.ttl');
  writeFileSync(file, turtle, 'utf-8');
  const nq = execFileSync('riot', ['--output=nq', file], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return nq.split('\n').filter((l) => l.length > 0).sort().join('\n') + '\n';
}

/**
 * Same key the test-fixture authoring script uses to stabilize gap ordering
 * before comparison. Sort: sourceField → severity → reason. Note `context`
 * is intentionally NOT in the sort key — the saved manifest preserves the
 * importer's emission order for gaps with otherwise-identical keys.
 */
function sortGaps(gaps: VocabularyGap[]): VocabularyGap[] {
  return [...gaps].sort((a, b) => {
    if (a.sourceField !== b.sourceField)
      return a.sourceField.localeCompare(b.sourceField);
    if (a.severity !== b.severity) return a.severity.localeCompare(b.severity);
    return a.reason.localeCompare(b.reason);
  });
}

/**
 * Compute the line-level diff between two strings, capped at 40 lines.
 * Used to surface the first divergence in the failure message.
 */
function shortDiff(actual: string, expected: string, maxLines = 40): string {
  const a = actual.split('\n');
  const e = expected.split('\n');
  const out: string[] = [];
  const maxIdx = Math.max(a.length, e.length);
  for (let i = 0; i < maxIdx && out.length < maxLines; i++) {
    if (a[i] === e[i]) continue;
    if (a[i] !== undefined) out.push(`- candidate[${i}]: ${a[i]}`);
    if (e[i] !== undefined) out.push(`+ expected[${i}]: ${e[i]}`);
  }
  return out.join('\n') || '(no line-level diff found within first 40 lines)';
}

describe('vcf conformance regression (Phase 3A)', () => {
  for (const { id, inputName } of FIXTURES) {
    describe(id, () => {
      const inputPath = path.join(FIXTURES_DIR, inputName);
      const expectedPath = path.join(FIXTURES_DIR, `${id}.expected.ttl`);
      const gapsPath = path.join(FIXTURES_DIR, `${id}.gaps.json`);

      it('produces byte-equal canonical n-quads against expected.ttl', async () => {
        // Read as a Buffer — the VCF importer auto-detects gzip and pipes
        // through Z_SYNC_FLUSH gunzip for partial BGZF tolerance.
        const inputBuf = readFileSync(inputPath);
        const result = await vcfImporter.convert(inputBuf, 'cascade', {
          ...CTX_BASE,
          inputPath,
        });

        expect(result.success).toBe(true);
        expect(result.errors).toEqual([]);

        const expected = readFileSync(expectedPath, 'utf-8');
        const actualNq = canonicalizeTurtle(result.output);
        const expectedNq = canonicalizeTurtle(expected);

        if (actualNq !== expectedNq) {
          throw new Error(
            `Conformance round-trip drift for ${id}.\n` +
              `Diff (candidate vs expected, first 40 differing lines):\n` +
              shortDiff(actualNq, expectedNq),
          );
        }
      });

      it('emits the expected vocabulary-gap manifest', async () => {
        const inputBuf = readFileSync(inputPath);
        const result = await vcfImporter.convert(inputBuf, 'cascade', {
          ...CTX_BASE,
          inputPath,
        });

        const expectedGaps: VocabularyGap[] = JSON.parse(
          readFileSync(gapsPath, 'utf-8'),
        );
        const actualGaps = sortGaps(result.vocabularyGaps);

        expect(actualGaps).toEqual(expectedGaps);
      });
    });
  }
});
