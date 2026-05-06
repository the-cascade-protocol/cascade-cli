/**
 * Conformance regression suite for the VRS importer (Phase 3B test fixture).
 *
 * Mirrors the TASK-1.9 pattern from tests/fhir-genomics-conformance.test.ts:
 *
 *   1. Run vrsImporter.convert() programmatically against the corpus
 *      `example-allele-BRCA2-deletion.input.json` fixture.
 *   2. Canonicalize candidate output and saved `<id>.expected.ttl` oracle
 *      via `riot --output=nq | sort` and assert byte-equal n-quads.
 *   3. Read `<id>.gaps.json`, sort the importer's emitted gaps with the
 *      same key, assert array equality.
 *
 * Hash-mismatch handling: this fixture was produced by vrs-python's
 * recursive-digest canonicalization, which cascade-cli does NOT reproduce
 * (per D-Q6: no seqrepo bundling). So the importer is exercised in
 * `--allow-vrs-hash-mismatch` mode (`options.allowVrsHashMismatch: true`),
 * which is the documented v0.1 happy-path for vrs-python alleles.
 *
 * The third test exercises the strict-mode negative path: an Allele whose
 * declared id is deliberately wrong (mutated payload after id was minted)
 * is rejected with a hash-mismatch error.
 *
 * Path resolution: by default the test resolves the conformance fixture
 * directory via the `conformance` symlink in the cascade-cli worktree.
 * For agents working in a conformance worktree where `<id>.expected.ttl`
 * lives on a feature branch, set `CASCADE_CONFORMANCE_DIR` to override.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { vrsImporter } from '../src/lib/vrs-converter/registry-entry.js';
import {
  computeSimpleVrsDigest,
  ingestVrsAllele,
} from '../src/lib/vrs-converter/allele.js';
import type {
  ImportContext,
  VocabularyGap,
} from '../src/lib/import-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_FIXTURES_DIR = path.resolve(
  __dirname,
  '../../conformance/fixtures/genomics/vrs',
);
const FIXTURES_DIR = process.env.CASCADE_CONFORMANCE_DIR
  ? path.resolve(
      process.env.CASCADE_CONFORMANCE_DIR,
      'fixtures/genomics/vrs',
    )
  : DEFAULT_FIXTURES_DIR;

const FIXTURE_ID = 'example-allele-BRCA2-deletion';

const CTX_PERMISSIVE: ImportContext = {
  inputPath: '<conformance>',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: { allowVrsHashMismatch: true },
};

const CTX_STRICT: ImportContext = {
  inputPath: '<conformance>',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: {},
};

/**
 * Canonicalize a Turtle string by writing it to a temp file, running
 * `riot --output=nq` against it, then sorting the n-quads alphabetically.
 * Mirrors the canonicalization helper in fhir-genomics-conformance.test.ts.
 */
function canonicalizeTurtle(turtle: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vrs-canon-'));
  const file = path.join(dir, 'in.ttl');
  writeFileSync(file, turtle, 'utf-8');
  const nq = execFileSync('riot', ['--output=nq', file], {
    encoding: 'utf-8',
  });
  return nq.split('\n').filter((l) => l.length > 0).sort().join('\n') + '\n';
}

/** Sort: sourceField → severity → reason. */
function sortGaps(gaps: VocabularyGap[]): VocabularyGap[] {
  return [...gaps].sort((a, b) => {
    if (a.sourceField !== b.sourceField)
      return a.sourceField.localeCompare(b.sourceField);
    if (a.severity !== b.severity) return a.severity.localeCompare(b.severity);
    return a.reason.localeCompare(b.reason);
  });
}

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

describe('vrs conformance regression (Phase 3B test fixture)', () => {
  describe(FIXTURE_ID, () => {
    const inputPath = path.join(FIXTURES_DIR, `${FIXTURE_ID}.input.json`);
    const expectedPath = path.join(FIXTURES_DIR, `${FIXTURE_ID}.expected.ttl`);
    const gapsPath = path.join(FIXTURES_DIR, `${FIXTURE_ID}.gaps.json`);

    it('produces byte-equal canonical n-quads against expected.ttl (under --allow-vrs-hash-mismatch)', async () => {
      const inputText = readFileSync(inputPath, 'utf-8');
      const result = await vrsImporter.convert(inputText, 'cascade', {
        ...CTX_PERMISSIVE,
        inputPath,
      });

      // Document the v0.1 hash-mismatch handling: the corpus Allele was
      // produced by vrs-python's recursive-digest canonicalization, which
      // cascade-cli does not reproduce (per D-Q6, no seqrepo bundling).
      // The --allow-vrs-hash-mismatch flag is the documented v0.1 path.
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.resourceCount).toBe(1);

      const expected = readFileSync(expectedPath, 'utf-8');
      const actualNq = canonicalizeTurtle(result.output);
      const expectedNq = canonicalizeTurtle(expected);

      if (actualNq !== expectedNq) {
        throw new Error(
          `Conformance round-trip drift for ${FIXTURE_ID}.\n` +
            `Diff (candidate vs expected, first 40 differing lines):\n` +
            shortDiff(actualNq, expectedNq),
        );
      }
    });

    it('emits the expected vocabulary-gap manifest', async () => {
      const inputText = readFileSync(inputPath, 'utf-8');
      const result = await vrsImporter.convert(inputText, 'cascade', {
        ...CTX_PERMISSIVE,
        inputPath,
      });

      const expectedGaps: VocabularyGap[] = JSON.parse(
        readFileSync(gapsPath, 'utf-8'),
      );
      const actualGaps = sortGaps(result.vocabularyGaps);

      expect(actualGaps).toEqual(expectedGaps);
    });

    it('rejects an Allele with a deliberately-wrong id in strict mode (hash-mismatch negative test)', () => {
      // Build a self-consistent synthetic Allele (id = simple canonical hash
      // of payload), then mutate state.sequence after the id was minted.
      // The simple hash now differs from the declared id → strict reject.
      const payload = {
        type: 'Allele' as const,
        location: {
          type: 'SequenceLocation',
          sequence_id: 'ga4gh:SQ.test',
          interval: {
            type: 'SequenceInterval',
            start: { type: 'Number', value: 100 },
            end: { type: 'Number', value: 101 },
          },
        },
        state: { type: 'LiteralSequenceExpression', sequence: 'A' },
      };
      const correctId = computeSimpleVrsDigest(payload);
      const tamperedAllele = {
        ...payload,
        id: correctId,
        // Mutate AFTER id was computed → simple hash will not match.
        state: { type: 'LiteralSequenceExpression', sequence: 'GGG' },
      };

      const out = ingestVrsAllele(tamperedAllele, CTX_STRICT);
      expect(out.error).toBeDefined();
      expect(out.error).toMatch(/hash mismatch/);
      expect(out.record).toBeUndefined();
    });
  });
});
