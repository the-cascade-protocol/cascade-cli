/**
 * The encounter join key: both transports write one visit's identifier the same
 * way, or the two halves of a duplicate can never be recognised as one visit.
 *
 * WHAT WAS MISSING
 * ----------------
 * `convertEncounter` READ `resource.identifier` (for identity minting, and only
 * when `resource.id` was absent) and never wrote it as a fact. The C-CDA path
 * has always written the same visit's identifier — the Epic contact serial
 * number, `<id root= extension=/>` — as `cascade:sourceRecordId`. So on a pod
 * holding both transports the join key sat on ONE side of every duplicate pair:
 * measured, 0 of 54 FHIR-derived encounter blocks carried a serial number while
 * 48 of the 52 C-CDA ones named the very same visits.
 *
 * WHICH PREDICATE, AND WHY
 * ------------------------
 * `cascade:sourceRecordId`, core v3: "the original source system record
 * identifier (e.g. C-CDA <id> element value) preserved for provenance". Two
 * reasons, both from the shapes rather than from taste:
 *
 *   `clinical:sourceRecordId` is constrained `sh:maxCount 1` on
 *   `clinical:EncounterShape` and already carries `Encounter.id`, the FHIR
 *   SERVER's resource id. FHIR `Encounter.identifier` is 0..*, so a second
 *   business identifier cannot go there without either evicting the resource id
 *   or violating the shape.
 *
 *   `cascade:sourceRecordId` carries no shape constraint on Encounter, is
 *   repeatable, and is ALREADY the predicate the C-CDA path writes this exact
 *   value on. Emitting it there is join parity by construction rather than by a
 *   matcher that has to know two spellings.
 *
 * IDENTITY IS UNTOUCHED. `mintSubjectUri` still keys on `resource.id` first;
 * this change adds a FACT, never an identity input. Deduplication is the
 * reconciler's judgement with a provenance trail, not the identity layer's
 * silent overwrite — see `ccda-converter/record-identity.ts` for the doctrine.
 *
 * Every fixture here is synthetic. The identifier OID is in the example-use
 * `.999.` arc.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';
import type { Quad } from 'n3';

import { convertCcda } from '../src/lib/ccda-converter/index.js';
import { convertEncounter } from '../src/lib/fhir-converter/converters-clinical.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../test-fixtures');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';
const CLINICAL = 'https://ns.cascadeprotocol.org/clinical/v1#';

/** The assigning authority and serial the two transports both state. */
const CSN_OID = '1.2.840.114350.1.13.999.2.7.3.698084.8';
const CSN_VALUE = '20100000001';
const CSN = `${CSN_OID}:${CSN_VALUE}`;

/** The FHIR twin of `test-fixtures/ccda-encounter-csn-twin.xml`. */
function fhirTwin(): Record<string, unknown> {
  return {
    resourceType: 'Encounter',
    id: 'eNcOuNtEr-twin-1',
    identifier: [{ use: 'usual', system: `urn:oid:${CSN_OID}`, value: CSN_VALUE }],
    status: 'finished',
    class: { system: 'urn:oid:1.2.840.114350.1.72.1.7.1', code: '5', display: 'Appointment' },
    type: [{ text: 'Office Visit' }],
    period: { start: '2025-04-01T16:00:00Z', end: '2025-04-01T16:45:00Z' },
  };
}

function valuesOf(quads: Quad[], predicate: string): string[] {
  return quads.filter((q) => q.predicate.value === predicate).map((q) => q.object.value).sort();
}

/** Every `cascade:sourceRecordId` carried by a `clinical:Encounter` subject. */
function encounterSourceIds(quads: Quad[], predicate = CASCADE + 'sourceRecordId'): string[] {
  const encounters = new Set(
    quads
      .filter((q) => q.predicate.value === RDF_TYPE && q.object.value === CLINICAL + 'Encounter')
      .map((q) => q.subject.value),
  );
  return quads
    .filter((q) => q.predicate.value === predicate && encounters.has(q.subject.value))
    .map((q) => q.object.value)
    .sort();
}

async function ccdaTwinQuads(): Promise<Quad[]> {
  const xml = fs.readFileSync(path.join(FIXTURES, 'ccda-encounter-csn-twin.xml'), 'utf-8');
  const result = await convertCcda(xml, {
    sourceSystem: 'TestSystem',
    importedAt: '2026-01-01T00:00:00Z',
  });
  expect(result.errors, `conversion errors: ${result.errors.join(', ')}`).toHaveLength(0);
  return new Parser().parse(result.output);
}

describe('the encounter identifier is written by BOTH transports, in one spelling', () => {
  it('the FHIR converter emits the identifier as system:value with urn:oid: stripped', () => {
    const quads = convertEncounter(fhirTwin())._quads;
    expect(valuesOf(quads, CASCADE + 'sourceRecordId')).toEqual([CSN]);
  });

  it('the two transports produce the SAME identifier string for the same visit', async () => {
    // The join key, stated as an equality rather than as two separate format
    // assertions: if either side changes its spelling, this fails even though
    // both sides still "emit an identifier".
    const fromFhir = encounterSourceIds(convertEncounter(fhirTwin())._quads);
    const fromCcda = encounterSourceIds(await ccdaTwinQuads());
    expect(fromCcda).not.toEqual([]);
    expect(fromFhir).toEqual(fromCcda);
  });

  it('emits every identifier the resource states, not only the first', () => {
    const resource = fhirTwin();
    (resource.identifier as unknown[]).push({
      system: 'urn:oid:1.2.840.114350.1.13.999.2.7.3.698084.68',
      value: 'AF-4471',
    });
    expect(valuesOf(convertEncounter(resource)._quads, CASCADE + 'sourceRecordId')).toEqual([
      CSN,
      '1.2.840.114350.1.13.999.2.7.3.698084.68:AF-4471',
    ].sort());
  });

  it('states a system-less identifier the way the C-CDA path states an extension-only id', () => {
    // `ccdaSourceId` renders `<id extension="X"/>` with no root as ":X". A FHIR
    // identifier with a value and no system is the same statement, and rendering
    // it as a bare "X" would make it collide with a differently-scoped id.
    const resource = fhirTwin();
    resource.identifier = [{ value: 'X-1' }];
    expect(valuesOf(convertEncounter(resource)._quads, CASCADE + 'sourceRecordId')).toEqual([':X-1']);
  });

  it('writes nothing for an identifier that carries no value', () => {
    const resource = fhirTwin();
    resource.identifier = [{ system: `urn:oid:${CSN_OID}` }, { use: 'usual' }];
    expect(valuesOf(convertEncounter(resource)._quads, CASCADE + 'sourceRecordId')).toEqual([]);
  });

  it('keeps the FHIR server resource id on its own predicate, unshared', () => {
    // The two are different things: one identifies the visit in the health
    // system, the other identifies the ROW on the FHIR server. Collapsing them
    // onto one predicate would put a `sh:maxCount 1` shape in an impossible
    // position and lose whichever value lost the race.
    const quads = convertEncounter(fhirTwin())._quads;
    expect(valuesOf(quads, CLINICAL + 'sourceRecordId')).toEqual(['eNcOuNtEr-twin-1']);
  });

  it('does not move the subject IRI: identity stays id-first', () => {
    // Pinned against the IRI this resource minted BEFORE the identifier became a
    // fact. An encounter IRI that moves is a duplicate visit on every pod that
    // already holds the record, plus a dangling clinical:hasEncounter edge from
    // everything that pointed at it.
    const withIdentifier = convertEncounter(fhirTwin())._quads[0].subject.value;
    const without = fhirTwin();
    delete without.identifier;
    const withoutIdentifier = convertEncounter(without)._quads[0].subject.value;
    expect(withIdentifier).toBe(withoutIdentifier);
  });
});

describe('3.208: the C-CDA encounter states its type and id in the canonical clinical: spellings', () => {
  it('emits clinical:encounterType and clinical:sourceRecordId', async () => {
    // `clinical:EncounterShape` constrains the `clinical:` spellings and says
    // nothing about the `cascade:` ones, so an encounter's type and source id
    // were validated on the FHIR transport and invisible on the C-CDA one.
    const quads = await ccdaTwinQuads();
    expect(encounterSourceIds(quads, CLINICAL + 'sourceRecordId')).toEqual([CSN]);
    expect(valuesOf(quads, CLINICAL + 'encounterType')).toEqual(['Office Visit']);
  });

  it('keeps cascade:sourceRecordId — it is the cross-transport join key, not a legacy spelling', async () => {
    // NOT a compatibility shim and NOT scheduled for retirement. This is the
    // predicate the FHIR path writes `Encounter.identifier` on and the one the
    // reconciler's encounter matcher keys on, so it is the only place the two
    // transports state the same visit under the same name. `clinical:` cannot
    // take over: `clinical:EncounterShape` pins `clinical:sourceRecordId` at
    // `sh:maxCount 1` and it already carries the FHIR server's resource id.
    //
    // Deleting either line below breaks encounter deduplication across
    // transports, silently, with no other test failing.
    const quads = await ccdaTwinQuads();
    expect(encounterSourceIds(quads, CASCADE + 'sourceRecordId')).toEqual([CSN]);
    expect(encounterSourceIds(quads, CLINICAL + 'sourceRecordId')).toEqual([CSN]);
  });

  it('no longer writes the retired cascade:encounterType spelling', async () => {
    // 3.269. `clinical:encounterType` became canonical in the wave that made the
    // C-CDA encounter state its type at all, and the `cascade:` spelling was
    // dual-written for one release while its readers migrated. All three were in
    // this repo; all three now read the canonical predicate.
    //
    // `clinical:EncounterShape` constrains `clinical:encounterType` and says
    // nothing about the `cascade:` one, so the retired spelling was a fact no
    // shape could check.
    const quads = await ccdaTwinQuads();
    expect(valuesOf(quads, CASCADE + 'encounterType')).toEqual([]);
    expect(valuesOf(quads, CLINICAL + 'encounterType')).toEqual(['Office Visit']);
  });
});
