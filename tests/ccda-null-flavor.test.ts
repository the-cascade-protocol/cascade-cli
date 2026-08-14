/**
 * The HL7 v3 NullFlavor to FHIR data-absent-reason mapping.
 *
 * WHY THIS FILE EXISTS RATHER THAN LEANING ON THE PATHOLOGY CORPUS. The P12
 * scenario exercises this mapping end to end, but its fixture carries only three
 * nullFlavors: UNK, NAV and ASKU. Mutating `NASK -> 'not-asked'` to
 * `NASK -> 'unknown'` left the ENTIRE suite green, which means the single
 * distinction most often lost on import ("nobody asked" versus "we asked and
 * were not told") was unpinned by anything. A corpus fixture proves the wiring;
 * only a table test proves the table.
 */

import { describe, it, expect } from 'vitest';
import {
  mapNullFlavorToDataAbsentReason,
  DATA_ABSENT_REASON_CODES,
} from '../src/lib/ccda-converter/null-flavor.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHAPES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shapes');

describe('nullFlavor to data-absent-reason', () => {
  // Each of these is a DIFFERENT clinical fact. Collapsing any pair is the
  // defect the mapping exists to end, so each is asserted individually rather
  // than through a loop over the table, which would just restate the table.
  it('keeps "nobody asked" and "we asked, they did not know" apart', () => {
    expect(mapNullFlavorToDataAbsentReason('NASK')).toBe('not-asked');
    expect(mapNullFlavorToDataAbsentReason('ASKU')).toBe('asked-unknown');
    expect(mapNullFlavorToDataAbsentReason('NASK')).not.toBe(
      mapNullFlavorToDataAbsentReason('ASKU'),
    );
  });

  it('keeps "coming later" apart from "not known"', () => {
    expect(mapNullFlavorToDataAbsentReason('NAV')).toBe('temp-unknown');
    expect(mapNullFlavorToDataAbsentReason('UNK')).toBe('unknown');
    expect(mapNullFlavorToDataAbsentReason('NAV')).not.toBe(
      mapNullFlavorToDataAbsentReason('UNK'),
    );
  });

  it('maps the remaining absence flavours', () => {
    expect(mapNullFlavorToDataAbsentReason('NI')).toBe('unknown');
    expect(mapNullFlavorToDataAbsentReason('MSK')).toBe('masked');
    expect(mapNullFlavorToDataAbsentReason('NA')).toBe('not-applicable');
    expect(mapNullFlavorToDataAbsentReason('OTH')).toBe('unsupported');
    expect(mapNullFlavorToDataAbsentReason('NINF')).toBe('negative-infinity');
    expect(mapNullFlavorToDataAbsentReason('PINF')).toBe('positive-infinity');
  });

  it('does NOT claim an absence for flavours that assert a value exists', () => {
    // DER (derivable), UNC (un-encoded), QS (non-zero but unquantified) and TRC
    // (trace) are claims ABOUT a value, not statements that one is missing.
    // Flattening them into an absence reason would assert something the source
    // did not say, so they return undefined and the record is left as it is.
    for (const code of ['DER', 'UNC', 'QS', 'TRC']) {
      expect(mapNullFlavorToDataAbsentReason(code), code).toBeUndefined();
    }
  });

  it('NAVU does not borrow temp-unknown', () => {
    // "Not available, no expectation of future availability" is the opposite of
    // temp-unknown's "expected later". There is no data-absent-reason code for
    // "never coming", so it must land on the weaker honest claim rather than on
    // one that asserts an expectation the source explicitly denied.
    expect(mapNullFlavorToDataAbsentReason('NAVU')).toBe('unknown');
    expect(mapNullFlavorToDataAbsentReason('NAVU')).not.toBe('temp-unknown');
  });

  it('an unrecognised flavour degrades to unknown, never to a guess', () => {
    // "unknown" asserts only that a value was expected and is missing, which is
    // true of every nullFlavor by definition, so it can never be wrong. A
    // specific reason can.
    expect(mapNullFlavorToDataAbsentReason('ZZZ')).toBe('unknown');
  });

  it('absence of a nullFlavor is not an absence reason', () => {
    for (const v of [undefined, null, '', '   ', 42, {}]) {
      expect(mapNullFlavorToDataAbsentReason(v)).toBeUndefined();
    }
  });

  it('is case- and whitespace-tolerant on the attribute value', () => {
    expect(mapNullFlavorToDataAbsentReason(' nask ')).toBe('not-asked');
    expect(mapNullFlavorToDataAbsentReason('AsKu')).toBe('asked-unknown');
  });

  it('every code it can emit is accepted by the bundled shape', () => {
    // The mapping and cascade:DataAbsentReasonShape's sh:in are two copies of one
    // value set. If they drift, the converter writes a pod its own validator
    // rejects. Read from the SHAPES rather than from a second hand-written list,
    // so this fails on a spec change rather than agreeing with a stale copy.
    const shape = fs.readFileSync(path.join(SHAPES, 'core.shapes.ttl'), 'utf-8');
    const block = shape.slice(shape.indexOf('cascade:DataAbsentReasonShape'));
    const inList = block.slice(block.indexOf('sh:in ('), block.indexOf(') ;', block.indexOf('sh:in (')));
    const accepted = [...inList.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    expect(accepted, 'the shape must actually declare a value set').not.toHaveLength(0);
    expect([...accepted].sort()).toEqual([...DATA_ABSENT_REASON_CODES].sort());

    for (const flavour of ['UNK', 'ASKU', 'NASK', 'NAV', 'NAVU', 'MSK', 'NA', 'OTH', 'NINF', 'PINF', 'ZZZ']) {
      const mapped = mapNullFlavorToDataAbsentReason(flavour);
      expect(accepted, `${flavour} -> ${mapped}`).toContain(mapped);
    }
  });

  it('never emits a raw NullFlavor code', () => {
    // The shape rejects raw NullFlavor codes deliberately: an absence with two
    // encodings turns "is this the same absence?" into a string comparison.
    for (const flavour of ['UNK', 'ASKU', 'NASK', 'NAV', 'NAVU', 'MSK', 'NA', 'OTH']) {
      expect(mapNullFlavorToDataAbsentReason(flavour)).not.toBe(flavour);
    }
  });
});
