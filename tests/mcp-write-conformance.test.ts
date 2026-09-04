/**
 * Shape conformance for the MCP write path.
 *
 * `cascade_write` is the one door an agent has into a Pod, and until this
 * suite existed nothing checked that what comes out of it satisfies the SHACL
 * shapes the CLI itself validates Pods against. It did not: every record it
 * wrote carried `cascade:dataProvenance cascade:AIGenerated`, a term that is
 * declared nowhere in the vocabulary, so every record violated the
 * `sh:in` constraint on `cascade:dataProvenance` in its own shape.
 *
 * The test drives the real write path — `buildRecordTurtle` plus
 * `generatePrefixes`, the same two functions `cascade_write` calls — over the
 * root record fixtures in the conformance corpus, and validates each result
 * with the CLI's own SHACL validator against the pinned `src/shapes/`.
 *
 * Scope is deliberately narrow: shapes only. This is not an identity or
 * determinism check; the record IRI here is the fixture's own, and nothing
 * about IRI minting is asserted.
 *
 * Fixtures whose remaining violations come from the flat `PROPERTY_PREDICATES`
 * map rather than from provenance are listed in `EXPECTED_FAILURES` with the
 * predicate and reason. That list is an inventory of known write-path gaps and
 * may only shrink: a fixture listed there that starts passing fails the test.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildRecordTurtle,
  generatePrefixes,
  TYPE_MAPPING,
} from '../src/lib/mcp/tools.js';
import { DATA_TYPES } from '../src/commands/pod/helpers.js';
import { loadShapes, validateTurtle } from '../src/lib/shacl-validator.js';
import { conformancePath, conformanceAvailable } from './helpers/conformance.js';

const FIXTURES_DIR = conformancePath('fixtures');

/**
 * Fixture `dataType` -> the `cascade_write` `dataType` enum value.
 *
 * Only the seven kinds `cascade_write` accepts appear here. Every other
 * fixture kind is counted as unmapped and reported, not silently dropped.
 */
const FIXTURE_TYPE_TO_MCP_TYPE: Record<string, string> = {
  Medication: 'medications',
  Condition: 'conditions',
  Allergy: 'allergies',
  LabResult: 'lab-results',
  Immunization: 'immunizations',
  VitalSign: 'vital-signs',
  Supplement: 'supplements',
};

/**
 * The fixture field holding the record's display name, per MCP data type.
 *
 * `cascade_write` takes the name under its own `nameKey` (or `name`); the
 * fixtures carry it under the vocabulary's property name. Translating it here
 * is what an agent handing this record to the tool would do, and it keeps the
 * suite about the write path rather than about a field-name mismatch that is
 * not part of the tool's contract.
 */
const FIXTURE_NAME_FIELDS: Record<string, string[]> = {
  medications: ['medicationName', 'drugName'],
  conditions: ['conditionName'],
  allergies: ['allergen'],
  'lab-results': ['testName'],
  immunizations: ['vaccineName'],
  'vital-signs': ['vitalType', 'type'],
  supplements: ['supplementName'],
};

/**
 * Known write-path gaps, keyed by fixture id. Each entry names the predicate
 * whose absence or shape causes the remaining violation and why.
 *
 * These are NOT provenance failures. They come from `PROPERTY_PREDICATES`
 * being one flat JSON-key -> predicate map shared by all seven record kinds,
 * so a key means the same predicate no matter which kind is being written.
 * Fixing them means giving the map a per-type dimension, which is a larger
 * change than this suite's subject.
 */
const EXPECTED_FAILURES: Record<string, string> = {
  // `isActive: true` maps to `clinical:status`, and formatTurtleValue
  // serializes a JSON boolean as a bare `true` (xsd:boolean). The shape wants
  // an xsd:string status word ("active"). One key cannot mean both a boolean
  // flag and a status vocabulary word.
  'med-001': 'clinical:status — isActive serialized as xsd:boolean, shape requires xsd:string',
  'med-002': 'clinical:status — isActive serialized as xsd:boolean, shape requires xsd:string',
  'med-003': 'clinical:status — isActive serialized as xsd:boolean, shape requires xsd:string',
  'med-004': 'clinical:status — isActive serialized as xsd:boolean, shape requires xsd:string',
  'med-005': 'clinical:status — isActive serialized as xsd:boolean, shape requires xsd:string',
  'med-006': 'clinical:status — isActive serialized as xsd:boolean, shape requires xsd:string',
  'med-007': 'clinical:status — isActive serialized as xsd:boolean, shape requires xsd:string',
  'med-011': 'clinical:status — isActive serialized as xsd:boolean, shape requires xsd:string',

  // formatTurtleValue stamps `^^xsd:dateTime` on any key whose name contains
  // "date" or "time", whatever the value's precision. A date-precision value
  // ("2031-02-09") becomes an ill-formed xsd:dateTime literal, which is neither
  // of the two types health:performedDate accepts.
  'lab-009': 'health:performedDate — date-precision value stamped ^^xsd:dateTime, so it is neither xsd:date nor a well-formed xsd:dateTime',

  // PROPERTY_PREDICATES has no `regulatoryStatus` key, so the field is dropped
  // and the predicate the Supplement shape requires is simply absent.
  'supp-001': 'clinical:regulatoryStatus — no PROPERTY_PREDICATES entry, so the field is dropped and the required predicate is missing',
};

interface Fixture {
  id: string;
  dataType?: string;
  vocabulary?: string;
  input?: Record<string, unknown>;
  /** `false` marks a fixture built to be REJECTED by the shapes. */
  shouldAccept?: boolean;
}

function loadRootFixtures(): Fixture[] {
  return fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, e.name), 'utf-8')) as Fixture)
    // Negative fixtures (`shouldAccept: false`) are records built to violate a
    // shape — an empty allergen, an interpretation outside the code system. The
    // write path faithfully serializing one still produces a violation, so
    // including them would measure the fixture, not the writer.
    .filter((f) => f.input !== undefined && f.vocabulary !== undefined && f.shouldAccept !== false)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Build the record object an agent would hand `cascade_write` for a fixture. */
function mcpRecordFor(mcpType: string, input: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = { ...input };
  // `id` and `type` are the fixture's own RDF discriminators, not record data.
  // `cascade_write` mints the IRI itself and derives rdf:type from `dataType`,
  // so an agent would not send either — and leaving `type` in would feed the
  // class name ("VitalSign") to the tool as the record's display name.
  delete record.id;
  delete record.type;
  const nameKey = TYPE_MAPPING[mcpType].nameKey;
  if (record[nameKey] === undefined) {
    for (const field of FIXTURE_NAME_FIELDS[mcpType] ?? []) {
      if (input[field] !== undefined) {
        record[nameKey] = input[field];
        break;
      }
    }
  }
  return record;
}

describe('MCP write path conforms to the SHACL shapes', () => {
  if (!conformanceAvailable()) {
    it.skip('conformance fixtures not available', () => {});
    return;
  }

  const fixtures = loadRootFixtures();
  const mapped = fixtures.filter((f) => f.dataType && FIXTURE_TYPE_TO_MCP_TYPE[f.dataType]);
  const unmapped = fixtures.filter((f) => !f.dataType || !FIXTURE_TYPE_TO_MCP_TYPE[f.dataType]);

  it('covers the fixture corpus, and reports what cascade_write cannot express', () => {
    // Not a threshold to tune. It records that the corpus was actually read
    // and that the split between what the write tool accepts and what it does
    // not is visible, rather than a silent zero-fixture pass.
    expect(fixtures.length).toBeGreaterThan(0);
    expect(mapped.length).toBeGreaterThan(0);
    // Every mapped fixture type must be a real `cascade_write` enum value.
    for (const type of Object.values(FIXTURE_TYPE_TO_MCP_TYPE)) {
      expect(DATA_TYPES[type], `cascade_write has no data type "${type}"`).toBeDefined();
      expect(TYPE_MAPPING[type], `TYPE_MAPPING has no entry for "${type}"`).toBeDefined();
    }
    console.log(
      `[mcp-write-conformance] ${fixtures.length} root fixtures: ` +
        `${mapped.length} map to a cascade_write data type, ${unmapped.length} do not ` +
        `(${[...new Set(unmapped.map((f) => f.dataType ?? 'untyped'))].sort().join(', ')})`,
    );
  });

  const { store, shapeFiles } = loadShapes();

  const failures: Array<{ id: string; issues: string[] }> = [];

  for (const fixture of mapped) {
    const mcpType = FIXTURE_TYPE_TO_MCP_TYPE[fixture.dataType!];
    const expectedFailure = EXPECTED_FAILURES[fixture.id];

    it(`${fixture.id} (${mcpType})${expectedFailure ? ' — known write-path gap' : ''}`, () => {
      const uri = (fixture.input!.id as string) ?? `urn:uuid:${fixture.id}`;
      const turtle =
        generatePrefixes() +
        '\n' +
        buildRecordTurtle(
          uri,
          mcpType,
          DATA_TYPES[mcpType],
          mcpRecordFor(mcpType, fixture.input!),
          { agentId: 'conformance-test-agent', reason: 'Shape conformance check' },
          '2026-01-01T00:00:00.000Z',
        );

      const result = validateTurtle(turtle, store, shapeFiles, `${fixture.id}.ttl`);
      const violations = result.results.filter((r) => r.severity === 'violation');
      const rendered = violations.map((v) => `${v.shape} ${v.property}: ${v.message}`);

      if (violations.length > 0) failures.push({ id: fixture.id, issues: rendered });

      if (expectedFailure) {
        // The list may only shrink. A listed fixture that now conforms must be
        // removed from EXPECTED_FAILURES rather than left as dead weight.
        expect(
          violations.length,
          `${fixture.id} is listed in EXPECTED_FAILURES ("${expectedFailure}") but now conforms — remove it from the list`,
        ).toBeGreaterThan(0);
        return;
      }

      expect(rendered, `${fixture.id} violates its shape`).toEqual([]);
    });
  }

  it('reports every violating fixture in one place', () => {
    if (failures.length > 0) {
      console.log(
        `[mcp-write-conformance] ${failures.length} of ${mapped.length} mapped fixtures violate their shape:\n` +
          failures.map((f) => `  ${f.id}\n    ${f.issues.join('\n    ')}`).join('\n'),
      );
    }
    const unexpected = failures.filter((f) => !EXPECTED_FAILURES[f.id]);
    expect(unexpected.map((f) => f.id)).toEqual([]);
  });
});
