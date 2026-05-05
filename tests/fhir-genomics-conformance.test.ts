/**
 * Conformance regression suite for the fhir-genomics importer (TASK-1.9).
 *
 * For each of the 7 FHIR Genomics IG corpus bundles in
 * `conformance/fixtures/genomics/fhir-genomics-ig/`, this test:
 *
 *   1. Runs the importer programmatically (NOT via CLI shell-out — direct
 *      `fhirGenomicsImporter.convert()` call so vitest stays fast).
 *   2. Canonicalizes both the candidate output and the saved
 *      `<id>.expected.ttl` oracle through `riot --output=nq | sort`.
 *   3. Asserts byte-equal n-quads. On failure, the test prints the diff
 *      (first 40 lines) so the breakage is debuggable from the failure log.
 *   4. Reads `<id>.gaps.json` and asserts the importer's emitted
 *      `vocabularyGaps` array (sorted with the same key as the saved
 *      manifest) matches byte-for-byte.
 *
 * Path resolution: by default the test resolves the conformance fixture
 * directory via the `conformance` symlink in the cascade-cli worktree
 * (which mirrors the existing C-CDA test pattern). For agents working in a
 * conformance worktree where `<id>.expected.ttl` lives on a feature branch,
 * set `CASCADE_CONFORMANCE_DIR` to override.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fhirGenomicsImporter } from '../src/lib/fhir-genomics-converter/registry-entry.js';
import type {
  ImportContext,
  VocabularyGap,
} from '../src/lib/import-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_FIXTURES_DIR = path.resolve(
  __dirname,
  '../../conformance/fixtures/genomics/fhir-genomics-ig',
);
const FIXTURES_DIR = process.env.CASCADE_CONFORMANCE_DIR
  ? path.resolve(
      process.env.CASCADE_CONFORMANCE_DIR,
      'fixtures/genomics/fhir-genomics-ig',
    )
  : DEFAULT_FIXTURES_DIR;

const BUNDLES = [
  'Bundle-bundle-CG-IG-HLA-FullBundle-01',
  'Bundle-bundle-cgexample',
  'Bundle-bundle-complexVariant-nonHGVS',
  'Bundle-bundle-compound-heterozygote',
  'Bundle-bundle-oncology-diagnostic',
  'Bundle-bundle-oncologyexamples-r4',
  'Bundle-bundle-pgxexample',
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
  const dir = mkdtempSync(path.join(tmpdir(), 'fhir-genomics-canon-'));
  const file = path.join(dir, 'in.ttl');
  writeFileSync(file, turtle, 'utf-8');
  const nq = execFileSync('riot', ['--output=nq', file], {
    encoding: 'utf-8',
  });
  // Sort lines (drop trailing empty line if present)
  return nq.split('\n').filter((l) => l.length > 0).sort().join('\n') + '\n';
}

/**
 * Same key the test-fixture authoring script uses to stabilize gap ordering
 * before comparison. Sort: sourceField → severity → reason.
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

describe('fhir-genomics conformance regression (TASK-1.9)', () => {
  for (const id of BUNDLES) {
    describe(id, () => {
      const inputPath = path.join(FIXTURES_DIR, `${id}.input.json`);
      const expectedPath = path.join(FIXTURES_DIR, `${id}.expected.ttl`);
      const gapsPath = path.join(FIXTURES_DIR, `${id}.gaps.json`);

      it('produces byte-equal canonical n-quads against expected.ttl', async () => {
        const inputText = readFileSync(inputPath, 'utf-8');
        const result = await fhirGenomicsImporter.convert(inputText, 'cascade', {
          ...CTX_BASE,
          inputPath,
        });

        expect(result.success).toBe(true);
        expect(result.errors).toEqual([]);

        const expected = readFileSync(expectedPath, 'utf-8');
        const actualNq = canonicalizeTurtle(result.output);
        const expectedNq = canonicalizeTurtle(expected);

        if (actualNq !== expectedNq) {
          // Use a custom error to keep the diff visible in the test log.
          throw new Error(
            `Conformance round-trip drift for ${id}.\n` +
              `Diff (candidate vs expected, first 40 differing lines):\n` +
              shortDiff(actualNq, expectedNq),
          );
        }
      });

      it('emits the expected vocabulary-gap manifest', async () => {
        const inputText = readFileSync(inputPath, 'utf-8');
        const result = await fhirGenomicsImporter.convert(inputText, 'cascade', {
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
