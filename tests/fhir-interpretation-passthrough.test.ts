/**
 * A lab interpretation is a coded finding, and the FHIR importer used to throw
 * most of it away.
 *
 * `Observation.interpretation` is bound in FHIR R4 to the HL7 v3
 * ObservationInterpretation code system. The importer mapped nine of its codes
 * onto four English words — H and L both became "abnormal", HH and LL both
 * became "critical" — and wrote "unknown" for every other code, which is where
 * susceptibility (S/I/R), detection (POS/NEG/DET/ND), reactivity (RR/WR/NR) and
 * change (B/D/U/W) results went. "The organism is resistant to this antibiotic"
 * and "the source said nothing" arrived in the pod as the same string.
 *
 * health v2.6 binds `health:interpretation` to that code system, so the codes
 * can now be carried as the source wrote them. "unknown" keeps exactly one
 * meaning: the source Observation carried no interpretation.
 *
 * The accepted set is the `sh:in` list in `src/shapes/health.shapes.ttl`, and
 * `ACCEPTED_INTERPRETATION_CODES` is a copy of it. A copy drifts, so the last
 * test here reads the shapes file and fails if the two disagree.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertObservationLab } from '../src/lib/fhir-converter/converters-clinical.js';
import { restoreLabResultRecord } from '../src/lib/fhir-converter/cascade-to-fhir-clinical.js';
import { NS } from '../src/lib/fhir-converter/types.js';
import {
  ACCEPTED_INTERPRETATION_CODES,
  interpretationValue,
} from '../src/lib/fhir-converter/interpretation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function labWith(interpretation: unknown): any {
  const obs: any = {
    resourceType: 'Observation',
    id: 'interp-1',
    code: { coding: [{ system: 'http://loinc.org', code: '2345-7', display: 'Glucose' }], text: 'Glucose' },
    category: [{ coding: [{ code: 'laboratory' }] }],
    valueQuantity: { value: 105, unit: 'mg/dL' },
    effectiveDateTime: '2024-01-15T10:30:00Z',
  };
  if (interpretation !== undefined) obs.interpretation = interpretation;
  return obs;
}

function interpretationOf(obs: any): string | undefined {
  const q = convertObservationLab(obs)._quads.find(
    (x: any) => x.predicate.value === NS.health + 'interpretation',
  );
  return q?.object.value;
}

describe('FHIR lab interpretation — codes pass through verbatim', () => {
  it('keeps H as H rather than flattening it to "abnormal"', () => {
    expect(interpretationOf(labWith([{ coding: [{ code: 'H' }] }]))).toBe('H');
  });

  it('keeps HH and LL distinct rather than merging them into "critical"', () => {
    expect(interpretationOf(labWith([{ coding: [{ code: 'HH' }] }]))).toBe('HH');
    expect(interpretationOf(labWith([{ coding: [{ code: 'LL' }] }]))).toBe('LL');
  });

  it('keeps H and L distinct', () => {
    expect(interpretationOf(labWith([{ coding: [{ code: 'H' }] }]))).toBe('H');
    expect(interpretationOf(labWith([{ coding: [{ code: 'L' }] }]))).toBe('L');
  });

  it('carries susceptibility results, which had no representation at all', () => {
    for (const code of ['S', 'I', 'R', 'SDD', 'SYN-S', 'SYN-R']) {
      expect(interpretationOf(labWith([{ coding: [{ code }] }])), code).toBe(code);
    }
  });

  it('carries detection and reactivity results', () => {
    for (const code of ['POS', 'NEG', 'DET', 'ND', 'IND', 'RR', 'WR', 'NR']) {
      expect(interpretationOf(labWith([{ coding: [{ code }] }])), code).toBe(code);
    }
  });

  it('carries change-over-time results', () => {
    for (const code of ['B', 'D', 'U', 'W']) {
      expect(interpretationOf(labWith([{ coding: [{ code }] }])), code).toBe(code);
    }
  });

  it('reads the code from the first coding of the first interpretation', () => {
    expect(
      interpretationOf(
        labWith([
          {
            coding: [
              { system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: 'A' },
            ],
          },
        ]),
      ),
    ).toBe('A');
  });
});

describe('FHIR lab interpretation — "unknown" means the source said nothing', () => {
  it('writes unknown when the Observation carries no interpretation', () => {
    expect(interpretationOf(labWith(undefined))).toBe('unknown');
  });

  it('writes unknown for an empty interpretation array', () => {
    expect(interpretationOf(labWith([]))).toBe('unknown');
  });

  it('writes unknown when the interpretation carries no code', () => {
    expect(interpretationOf(labWith([{ text: 'high' }]))).toBe('unknown');
  });
});

describe('FHIR lab interpretation — a code outside the accepted set', () => {
  it('drops the property rather than writing "unknown", and warns naming the code', () => {
    // The property is absent, and that is the POINT rather than an oversight.
    // Writing "unknown" here was the defect: "unknown" is the data-absent-reason
    // code, and this module's contract is that it means the source carried NO
    // interpretation. Using it for a code the vocabulary cannot express asserts
    // something the source never said, and stores two different facts as one
    // string — while the warning that distinguishes them lasts only as long as
    // the import.
    const result = convertObservationLab(labWith([{ coding: [{ code: 'ZZZ-not-a-code' }] }]));
    const value = result._quads.find(
      (x: any) => x.predicate.value === NS.health + 'interpretation',
    )?.object.value;
    expect(value).toBeUndefined();
    expect(result.warnings.join(' ')).toContain('ZZZ-not-a-code');
  });

  it('is distinguishable in the pod from an Observation that stated none', () => {
    // The whole distinction, in one assertion: the two cases must not produce
    // the same triple. Absent for the code this vocabulary cannot express;
    // "unknown" for the source that reported nothing.
    expect(interpretationOf(labWith([{ coding: [{ code: 'ZZZ-not-a-code' }] }]))).toBeUndefined();
    expect(interpretationOf(labWith(undefined))).toBe('unknown');
  });

  it('still uses the nearest legacy mapping where one applies', () => {
    // The fallback map is not dead: a code IN it is mapped rather than dropped.
    // Reached through the function directly, since every key of that map is also
    // in the accepted set and so takes the verbatim path from a real resource.
    const warnings: string[] = [];
    expect(interpretationValue([{ coding: [{ code: 'N' }] }], warnings)).toBe('N');
    expect(warnings).toEqual([]);
  });
});

describe('FHIR lab interpretation — round trip', () => {
  it('H survives Cascade and comes back as H', () => {
    const quads = convertObservationLab(labWith([{ coding: [{ code: 'H' }] }]))._quads;
    const pv = new Map<string, string[]>();
    for (const q of quads as any[]) {
      const arr = pv.get(q.predicate.value) ?? [];
      arr.push(q.object.value);
      pv.set(q.predicate.value, arr);
    }
    const restored: any = restoreLabResultRecord(pv as any, []);
    expect(restored.interpretation[0].coding[0].code).toBe('H');
  });
});

describe('FHIR lab interpretation — the accepted set matches the shapes', () => {
  it('ACCEPTED_INTERPRETATION_CODES is exactly the health:interpretation sh:in list', () => {
    const shapes = fs.readFileSync(
      path.resolve(__dirname, '../src/shapes/health.shapes.ttl'),
      'utf-8',
    );
    const block = shapes.slice(shapes.indexOf('sh:path health:interpretation'));
    const inStart = block.indexOf('sh:in (');
    const inEnd = block.indexOf(') ;', inStart);
    expect(inStart, 'health:interpretation sh:in list not found in the shapes').toBeGreaterThan(-1);

    const codes = [...block.slice(inStart, inEnd).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(50);
    expect([...ACCEPTED_INTERPRETATION_CODES].sort()).toEqual([...new Set(codes)].sort());
  });
});
