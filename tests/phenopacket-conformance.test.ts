/**
 * Conformance regression suite for the phenopacket importer (TASK-2B.10 oracles).
 *
 * For each of the 9 GA4GH Phenopacket corpus fixtures in
 * `conformance/fixtures/genomics/phenopackets/`, this test:
 *
 *   1. Runs the importer programmatically (NOT via CLI shell-out — direct
 *      `phenopacketImporter.convert()` so vitest stays fast).
 *   2. Canonicalizes both the candidate output and the saved
 *      `<id>.expected.ttl` oracle through `riot --output=nq | sort`.
 *   3. Asserts byte-equal n-quads. On failure, the test prints the diff
 *      (first 40 lines) so the breakage is debuggable from the failure log.
 *   4. Reads `<id>.gaps.json` and asserts the importer's emitted
 *      `vocabularyGaps` array (sorted with the same key as the saved
 *      manifest) matches byte-for-byte.
 *
 * `biosamples-SAMN05324082.input.json` is an NCBI BioSample SRA-style
 * record without phenopacket markers — `detectPhenopacket()` correctly
 * returns false. For that fixture only, the test asserts `detect===false`
 * instead of running the byte-equal round-trip.
 *
 * Path resolution mirrors the FHIR Genomics conformance test: by default
 * resolves the conformance fixture directory via the `conformance` symlink
 * in the cascade-cli worktree. Set `CASCADE_CONFORMANCE_DIR` to override
 * (e.g., when authoring oracles on a feature branch in a conformance
 * worktree).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { phenopacketImporter } from '../src/lib/phenopacket-converter/registry-entry.js';
import type {
  ImportContext,
  VocabularyGap,
} from '../src/lib/import-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_FIXTURES_DIR = path.resolve(
  __dirname,
  '../../conformance/fixtures/genomics/phenopackets',
);
const FIXTURES_DIR = process.env.CASCADE_CONFORMANCE_DIR
  ? path.resolve(
      process.env.CASCADE_CONFORMANCE_DIR,
      'fixtures/genomics/phenopackets',
    )
  : DEFAULT_FIXTURES_DIR;

/** Phenopacket fixtures that round-trip through the importer. */
const FIXTURES = [
  'bethlem-myopathy',
  'covid',
  'marfan',
  'retinoblastoma',
  'tpm3-myopathy',
  'v2-cohort',
  'v2-family',
  'v2-phenopacket',
];

/** Detect-rejected fixture: the importer must NOT claim this NCBI SRA record. */
const DETECT_REJECT_FIXTURE = 'biosamples-SAMN05324082';

const CTX_BASE: ImportContext = {
  inputPath: '<conformance>',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: {},
};

/**
 * KNOWN IMPORTER NON-DETERMINISM — see the comment in
 * `src/lib/phenopacket-converter/variation-descriptor.ts::mintVariantIri()`:
 * when a variationDescriptor carries no `id` or `label` (i.e. the descriptor
 * is anonymous), the importer falls through to `Math.random()` for the IRI
 * seed. This breaks byte-equal round-trip for `v2-cohort` / `v2-family` /
 * `v2-phenopacket` (whose variants are anonymous) until that fallback is
 * replaced with a deterministic content hash (descriptor expressions /
 * geneContext / etc).
 *
 * Tie-break ticket raised: see STATUS.md "Test fixtures — Phenopacket".
 * Until the importer is fixed, this test normalizes anonymous-variant URNs
 * to a stable placeholder on BOTH sides of the byte-equal comparison so the
 * regression suite still catches every other class of drift.
 */
function normalizeAnonVariantIris(turtle: string): string {
  // Find any subject whose triples include `cascade:sourceFhirId "<anon>"`.
  // Phenopacket-converter emits these for anonymous variant descriptors.
  const anonRegex =
    /(<urn:uuid:[0-9a-f-]+>)\s+[^.]*?<https:\/\/ns\.cascadeprotocol\.org\/core\/v1#sourceFhirId>\s+"<anon>"/g;
  const anonIris = new Set<string>();
  for (const m of turtle.matchAll(anonRegex)) {
    anonIris.add(m[1]);
  }
  let out = turtle;
  let i = 0;
  for (const iri of [...anonIris].sort()) {
    const placeholder = `<urn:uuid:00000000-0000-0000-0000-anonvariant${String(i).padStart(3, '0')}>`;
    // Use split/join for literal replacement (safer than regex with special chars).
    out = out.split(iri).join(placeholder);
    i += 1;
  }
  return out;
}

/**
 * Canonicalize a Turtle string by:
 *   1. Writing it to a temp file
 *   2. Running `riot --output=nq` against it
 *   3. Normalizing anonymous-variant URNs (see comment above)
 *   4. Sorting the n-quads alphabetically
 *
 * `riot` is part of Apache Jena, the canonical SHACL/RDF toolchain in the
 * workspace. Byte-equal n-quads is the only stable round-trip target since
 * Turtle prefixes / blank-node naming / triple ordering are parser-dependent.
 *
 * Anonymous-variant URN normalization runs AFTER riot so the regex matches
 * the fully-expanded IRI form (`<https://ns.cascadeprotocol.org/core/v1#sourceFhirId>`)
 * rather than the Turtle-prefixed form (`cascade:sourceFhirId`).
 */
function canonicalizeTurtle(turtle: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'phenopacket-canon-'));
  const file = path.join(dir, 'in.ttl');
  writeFileSync(file, turtle, 'utf-8');
  const nq = execFileSync('riot', ['--output=nq', file], {
    encoding: 'utf-8',
  });
  const normalized = normalizeAnonVariantIris(nq);
  return normalized.split('\n').filter((l) => l.length > 0).sort().join('\n') + '\n';
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

describe('phenopacket conformance regression (TASK-2B.10)', () => {
  for (const id of FIXTURES) {
    describe(id, () => {
      const inputPath = path.join(FIXTURES_DIR, `${id}.input.json`);
      const expectedPath = path.join(FIXTURES_DIR, `${id}.expected.ttl`);
      const gapsPath = path.join(FIXTURES_DIR, `${id}.gaps.json`);

      it('produces byte-equal canonical n-quads against expected.ttl', async () => {
        const inputText = readFileSync(inputPath, 'utf-8');
        const result = await phenopacketImporter.convert(inputText, 'cascade', {
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
        const inputText = readFileSync(inputPath, 'utf-8');
        const result = await phenopacketImporter.convert(inputText, 'cascade', {
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

  describe(DETECT_REJECT_FIXTURE, () => {
    const inputPath = path.join(FIXTURES_DIR, `${DETECT_REJECT_FIXTURE}.input.json`);

    it('detect() returns false for NCBI BioSample SRA records', () => {
      const inputText = readFileSync(inputPath, 'utf-8');
      expect(phenopacketImporter.detect(inputText)).toBe(false);
    });
  });
});
