/**
 * A four-series MRI imported as one series must not call itself fully mapped
 * (3.222, the honesty half).
 *
 * THE DEFECT
 * ----------
 * `convertImagingStudy` reads the modality from `series[0]` and the retrieve
 * URL from `series[0].endpoint[0]`, and then asserted
 * `cascade:layerPromotionStatus = cascade:FullyMapped` unconditionally. A study
 * holding four series therefore entered the pod carrying ONE series' modality
 * under a statement that the record was completely mapped. Nothing in the pod,
 * and nothing in the import output, said that three series had been dropped —
 * and `clinical:numberOfSeries` sat right next to the single modality saying
 * "4", which reads as a fact about the study rather than as the count of what
 * was discarded.
 *
 * WHAT THIS FIXES, AND WHAT IT DELIBERATELY DOES NOT
 * --------------------------------------------------
 * Only the statement. The record still carries series 1 alone: emitting every
 * series needs a modelling decision about how a series is represented in the
 * pod, and that decision is pending. Making the converter honest is separable
 * from making it complete, and shipping the honesty first is what stops a
 * partial import from being indistinguishable from a complete one in the
 * meantime.
 *
 * `numberOfSeries` counts too, not just the array. A server that states
 * `numberOfSeries: 3` while inlining one series has told us two series exist
 * that this record does not describe, and that is the same loss.
 *
 * Every resource below is authored for this test.
 */

import { describe, it, expect } from 'vitest';
import { convertImagingStudy } from '../src/lib/fhir-converter/converters-clinical.js';
import { convertFhirToCascade } from '../src/lib/fhir-converter/index.js';
import { convertCascadeToFhir } from '../src/lib/fhir-converter/cascade-to-fhir.js';
import { NS } from '../src/lib/fhir-converter/types.js';

function value(quads: any[], predicateIri: string): string | undefined {
  return quads.find((q: any) => q.predicate.value === predicateIri)?.object?.value;
}

function series(modality: string, uid: string) {
  return {
    uid,
    modality: { system: 'http://dicom.nema.org/resources/ontology/DCM', code: modality },
    endpoint: [{ reference: `Endpoint/wado-${uid}` }],
  };
}

function study(overrides: Record<string, unknown> = {}): any {
  return {
    resourceType: 'ImagingStudy',
    id: 'imgstudy-lumbar-1',
    status: 'available',
    started: '2026-02-19T08:05:00Z',
    description: 'MRI Lumbar Spine without contrast',
    identifier: [{ system: 'urn:dicom:uid', value: 'urn:oid:1.2.840.99999.1.2.3' }],
    ...overrides,
  };
}

describe('a partially represented ImagingStudy does not claim FullyMapped (3.222)', () => {
  it('four series in, one series represented, and the record says so', () => {
    const result = convertImagingStudy(
      study({
        numberOfSeries: 4,
        series: [
          series('MR', '1.1'),
          series('MR', '1.2'),
          series('MR', '1.3'),
          series('MR', '1.4'),
        ],
      }),
    );

    // The exact warning, alone, in position 0 — not merely "a warning exists",
    // and the count in it is the count that was actually dropped.
    expect(result.warnings).toEqual([
      'ImagingStudy states 4 series; this record represents only the first (kept series 1 ' +
        'of 4). Modality and retrieve URL are read from that series alone, so the record is ' +
        'not marked fully mapped.',
    ]);

    expect(value(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(
      NS.cascade + 'PendingLayerTwoPromotion',
    );
    expect(value(result._quads, NS.cascade + 'layerPromotionStatus')).not.toBe(
      NS.cascade + 'FullyMapped',
    );
  });

  it('what IS kept is unchanged: series 1 still supplies modality and retrieve URL', () => {
    // The fix is to the statement, not to the payload. A fix that also quietly
    // stopped emitting the one series it does keep would be a regression.
    const result = convertImagingStudy(
      study({
        numberOfSeries: 2,
        series: [series('CT', '2.1'), series('MR', '2.2')],
      }),
    );

    expect(value(result._quads, NS.rdf + 'type')).toBe(NS.clinical + 'ImagingStudy');
    expect(value(result._quads, NS.clinical + 'imagingModality')).toBe('CT');
    expect(value(result._quads, NS.clinical + 'retrieveUrl')).toBe('Endpoint/wado-2.1');
    expect(value(result._quads, NS.clinical + 'numberOfSeries')).toBe('2');
    expect(value(result._quads, NS.clinical + 'studyDescription')).toBe(
      'MRI Lumbar Spine without contrast',
    );
  });

  it('numberOfSeries above what is inlined is the same loss, and warns the same way', () => {
    // One series in the array, three declared. Two series exist that this
    // record does not describe.
    const result = convertImagingStudy(
      study({ numberOfSeries: 3, series: [series('US', '3.1')] }),
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('kept series 1 of 3');
    expect(value(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(
      NS.cascade + 'PendingLayerTwoPromotion',
    );
  });

  it('series declared but none inlined reports what it kept, which is none', () => {
    const result = convertImagingStudy(study({ numberOfSeries: 2, series: [] }));

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('kept series 0 of 2');
  });

  it('the dropped count comes from the study, not from a constant', () => {
    const seven = convertImagingStudy(
      study({
        numberOfSeries: 7,
        series: Array.from({ length: 7 }, (_, i) => series('CT', `7.${i}`)),
      }),
    );
    expect(seven.warnings[0]).toContain('kept series 1 of 7');
    expect(seven.warnings[0]).toContain('states 7 series');
  });
});

describe('a single-series ImagingStudy is unchanged (3.222)', () => {
  it('one series, one modality, fully mapped and silent', () => {
    const result = convertImagingStudy(
      study({ numberOfSeries: 1, series: [series('MR', '4.1')] }),
    );

    expect(result.warnings).toEqual([]);
    expect(value(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(
      NS.cascade + 'FullyMapped',
    );
    expect(value(result._quads, NS.clinical + 'imagingModality')).toBe('MR');
  });

  it('a study stating no series at all is not accused of dropping any', () => {
    const result = convertImagingStudy(study());

    expect(result.warnings).toEqual([]);
    expect(value(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(
      NS.cascade + 'FullyMapped',
    );
  });
});

describe('the honest status does not break the round trip (3.222)', () => {
  it('a multi-series study still restores as an ImagingStudy, not as a passthrough', async () => {
    // `cascade:PendingLayerTwoPromotion` is also the marker on Layer 1
    // passthrough records, which restore by replaying `cascade:fhirJson` — a
    // property this record does not carry. The reverse dispatcher matches on
    // rdf:type first, and this pins that it keeps doing so.
    const forward = await convertFhirToCascade(
      study({ numberOfSeries: 4, series: [series('MR', '5.1'), series('MR', '5.2')] }),
    );
    const back = await convertCascadeToFhir(forward.turtle);

    expect(back.warnings).toEqual([]);
    expect(back.resources).toHaveLength(1);
    expect(back.resources[0].resourceType).toBe('ImagingStudy');
    expect(back.resources[0].id).toBe('imgstudy-lumbar-1');
  });

  it('the conversion warning reaches the caller of convertFhirToCascade', async () => {
    // A warning the import path never surfaces is the same silence in a
    // different place.
    const result = await convertFhirToCascade(
      study({ numberOfSeries: 4, series: [series('MR', '6.1'), series('MR', '6.2')] }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('kept series 1 of 4');
  });
});
