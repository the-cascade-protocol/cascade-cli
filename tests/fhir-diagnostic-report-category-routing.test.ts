/**
 * A DiagnosticReport is not always a laboratory report (3.221).
 *
 * THE DEFECT
 * ----------
 * The dispatcher routed EVERY `DiagnosticReport` to the laboratory converter,
 * whose first act was to assert `clinical:LaboratoryReport`. A radiology report
 * therefore entered the pod typed as a lab report: the class was wrong, and
 * "what imaging do I have?" returned nothing while the report sat in the pod
 * under a class no imaging query looks at. Nothing warned, because from inside
 * the converter every DiagnosticReport looked the same.
 *
 * WHAT ROUTES
 * -----------
 * `DiagnosticReport.category`, bound in FHIR R4 to the HL7 v2-0074 diagnostic
 * service section codes. Three outcomes, and the third is the point:
 *
 *   1. A laboratory service section (LAB, CH, HM, MB, ...) or no category at
 *      all keeps `clinical:LaboratoryReport`. Absent stays lab because that is
 *      what the pod already holds and what a DiagnosticReport with no stated
 *      section overwhelmingly is; changing it would retype existing records on
 *      no evidence.
 *   2. An imaging service section (RAD, CT, MR, NMS, US, RX, ...) produces
 *      `clinical:ImagingReport`, which is ratified in clinical.ttl with a SHACL
 *      shape and was already listed in the converter's required-fields table.
 *      No vocabulary is invented here.
 *   3. Anything else — surgical pathology, cytogenetics, pulmonary function —
 *      is NOT given a new class. There is no ratified Cascade class for those
 *      and inventing one in a converter is how vocabulary rots. The record
 *      keeps the class it had, a warning names the category that went
 *      unrouted, and the record stops claiming `cascade:FullyMapped`, because
 *      it is not. That is the honest statement of a known gap rather than a
 *      silent miscategorisation.
 *
 * Every resource below is authored for this test.
 */

import { describe, it, expect } from 'vitest';
import { convertDiagnosticReport } from '../src/lib/fhir-converter/converters-clinical.js';
import { convertFhirToCascade } from '../src/lib/fhir-converter/index.js';
import { convertCascadeToFhir } from '../src/lib/fhir-converter/cascade-to-fhir.js';
import { NS, mintSubjectUri } from '../src/lib/fhir-converter/types.js';
import { DATA_TYPES } from '../src/lib/pod-data-types.js';

function value(quads: any[], predicateIri: string): string | undefined {
  return quads.find((q: any) => q.predicate.value === predicateIri)?.object?.value;
}

/** A DiagnosticReport carrying whatever `category` the case under test needs. */
function report(category?: unknown, overrides: Record<string, unknown> = {}): any {
  const resource: any = {
    resourceType: 'DiagnosticReport',
    id: 'dr-routing-1',
    status: 'final',
    code: {
      coding: [{ system: 'http://loinc.org', code: '24627-2', display: 'CT Chest' }],
      text: 'CT Chest without contrast',
    },
    effectiveDateTime: '2026-01-14T09:30:00Z',
    issued: '2026-01-14T15:02:00Z',
    performer: [{ display: 'Brightwater Imaging Center' }],
    ...overrides,
  };
  if (category !== undefined) resource.category = category;
  return resource;
}

/** The v2-0074 shorthand: one coding, code only. */
function section(code: string): unknown {
  return [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code }] }];
}

describe('DiagnosticReport routes on category (3.221)', () => {
  it('a RAD report is a clinical:ImagingReport, not a laboratory report', () => {
    const result = convertDiagnosticReport(report(section('RAD')));

    expect(value(result._quads, NS.rdf + 'type')).toBe(NS.clinical + 'ImagingReport');
    expect(result.cascadeType).toBe('clinical:ImagingReport');
    expect(result.resourceType).toBe('DiagnosticReport');
    // The category itself is still recorded as a fact, unchanged.
    expect(value(result._quads, NS.clinical + 'reportCategory')).toBe('RAD');
    // Routing correctly is a full mapping, so nothing is warned and nothing is
    // downgraded.
    expect(result.warnings).toEqual([]);
    expect(value(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(
      NS.cascade + 'FullyMapped',
    );
  });

  it('every imaging service section routes to ImagingReport, not just RAD', () => {
    // The modality sections a real export uses. Each is checked as its own
    // assertion so a failure names the code that regressed.
    for (const code of ['RAD', 'CT', 'MR', 'NMR', 'NMS', 'US', 'RUS', 'OUS', 'VUS', 'RX', 'XRC']) {
      const result = convertDiagnosticReport(report(section(code)));
      expect(value(result._quads, NS.rdf + 'type'), `category ${code}`).toBe(
        NS.clinical + 'ImagingReport',
      );
      expect(result.warnings, `category ${code}`).toEqual([]);
    }
  });

  it('a LAB report keeps clinical:LaboratoryReport', () => {
    const result = convertDiagnosticReport(report(section('LAB')));

    expect(value(result._quads, NS.rdf + 'type')).toBe(NS.clinical + 'LaboratoryReport');
    expect(result.cascadeType).toBe('clinical:LaboratoryReport');
    expect(result.warnings).toEqual([]);
    expect(value(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(
      NS.cascade + 'FullyMapped',
    );
  });

  it('the lab-shaped service sections a real export uses all stay laboratory reports', () => {
    // HM in particular: it is what the field-coverage fixture carries, and a
    // routing table that only knew the literal string "LAB" would have started
    // warning on ordinary hematology.
    for (const code of ['LAB', 'CH', 'HM', 'MB', 'BLB', 'SR', 'TX', 'VR', 'MYC', 'MCB', 'IMM', 'BG', 'OSL']) {
      const result = convertDiagnosticReport(report(section(code)));
      expect(value(result._quads, NS.rdf + 'type'), `category ${code}`).toBe(
        NS.clinical + 'LaboratoryReport',
      );
      expect(result.warnings, `category ${code}`).toEqual([]);
    }
  });

  it('a report with no category at all keeps the behaviour the pod already has', () => {
    const result = convertDiagnosticReport(report(undefined));

    expect(value(result._quads, NS.rdf + 'type')).toBe(NS.clinical + 'LaboratoryReport');
    expect(result.warnings).toEqual([]);
    expect(value(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(
      NS.cascade + 'FullyMapped',
    );
  });

  it('an empty category array is treated as no category, not as an unrouted one', () => {
    const result = convertDiagnosticReport(report([]));

    expect(value(result._quads, NS.rdf + 'type')).toBe(NS.clinical + 'LaboratoryReport');
    expect(result.warnings).toEqual([]);
  });

  it('a text-only category still routes', () => {
    const imaging = convertDiagnosticReport(report([{ text: 'Radiology' }]));
    expect(value(imaging._quads, NS.rdf + 'type')).toBe(NS.clinical + 'ImagingReport');
    expect(imaging.warnings).toEqual([]);

    const lab = convertDiagnosticReport(report([{ text: 'Laboratory' }]));
    expect(value(lab._quads, NS.rdf + 'type')).toBe(NS.clinical + 'LaboratoryReport');
    expect(lab.warnings).toEqual([]);
  });
});

describe('an unrouted category is stated, not guessed (3.221)', () => {
  it('surgical pathology keeps its class and says so', () => {
    const result = convertDiagnosticReport(report(section('SP')));

    // No invented class. The vocabulary gap is tracked separately; a converter
    // is not where it gets closed.
    expect(value(result._quads, NS.rdf + 'type')).toBe(NS.clinical + 'LaboratoryReport');
    expect(result.cascadeType).toBe('clinical:LaboratoryReport');

    // The exact warning, in position 0 — not merely "a warning exists".
    expect(result.warnings).toEqual([
      'DiagnosticReport category "SP" is neither a laboratory nor an imaging diagnostic ' +
        'service section (HL7 v2-0074). The record keeps clinical:LaboratoryReport, which ' +
        'is not what it is: no ratified Cascade class covers this category, so it is not ' +
        'marked fully mapped.',
    ]);

    // And the record does not claim to be fully mapped, because it is not.
    expect(value(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(
      NS.cascade + 'PendingLayerTwoPromotion',
    );
  });

  it('the warning names the category that went unrouted, whichever it is', () => {
    const cytogenetics = convertDiagnosticReport(report(section('CG')));
    expect(cytogenetics.warnings).toHaveLength(1);
    expect(cytogenetics.warnings[0]).toContain('"CG"');
    expect(value(cytogenetics._quads, NS.cascade + 'layerPromotionStatus')).toBe(
      NS.cascade + 'PendingLayerTwoPromotion',
    );

    const pulmonary = convertDiagnosticReport(report(section('PF')));
    expect(pulmonary.warnings).toHaveLength(1);
    expect(pulmonary.warnings[0]).toContain('"PF"');
  });

  it('a category nobody has a table for is unrouted rather than silently lab', () => {
    const result = convertDiagnosticReport(report([{ text: 'Sleep Study' }]));

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('"Sleep Study"');
    expect(value(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(
      NS.cascade + 'PendingLayerTwoPromotion',
    );
  });
});

describe('routing changes the class, never the identity (3.221)', () => {
  it('an imaging report keeps the subject the identity chokepoint mints', () => {
    const resource = report(section('RAD'));
    const result = convertDiagnosticReport(resource);

    const subject = result._quads[0].subject.value;
    // Same door as every other converter — no inline URI construction on the
    // new branch. This repo has had three incidents from exactly that.
    expect(subject).toBe(mintSubjectUri(resource));
    expect(subject.startsWith('urn:uuid:')).toBe(true);
  });

  it('the subject does not move when the category changes the class', () => {
    // The identity seed is the resource id, so retyping must not re-key the
    // record: an existing pod entry must not fork into two on upgrade.
    const rad = convertDiagnosticReport(report(section('RAD')));
    const lab = convertDiagnosticReport(report(section('LAB')));
    expect(rad._quads[0].subject.value).toBe(lab._quads[0].subject.value);
  });
});

describe('the dispatcher and the round trip carry the routing (3.221)', () => {
  it('convertFhirToCascade routes a RAD report, not just the converter', () => {
    // Pinning the converter alone would leave the dispatcher free to keep
    // calling the lab path, which is the actual defect.
    return convertFhirToCascade(report(section('RAD'))).then((result) => {
      expect(result.cascadeType).toBe('clinical:ImagingReport');
      expect(result.turtle).toContain('clinical:ImagingReport');
    });
  });

  it('an ImagingReport restores to a DiagnosticReport instead of warning as unknown', async () => {
    const forward = await convertFhirToCascade(report(section('RAD')));
    // The record really is typed as an imaging report before the restore runs;
    // otherwise this test would be a round trip of a laboratory report and
    // would pass without the restore branch existing at all.
    expect(forward.turtle).toContain('clinical:ImagingReport');
    const back = await convertCascadeToFhir(forward.turtle);

    expect(back.warnings).toEqual([]);
    expect(back.resources).toHaveLength(1);
    expect(back.resources[0].resourceType).toBe('DiagnosticReport');
    expect(back.resources[0].id).toBe('dr-routing-1');
    expect(back.resources[0].status).toBe('final');
    expect(back.resources[0].category).toEqual([{ coding: [{ code: 'RAD' }] }]);
  });
});

describe('an imaging report has a bucket to land in (3.221)', () => {
  it('DATA_TYPES routes clinical:ImagingReport, so it is not filed as a passthrough', () => {
    // Without this the routing fix would be self-defeating: `routeTypeKey` has
    // no bucket for an unregistered type and falls through to
    // `fhir-passthrough`, so a correctly typed radiology report would be filed
    // as an unmapped Layer 1 record and would disappear from `pod info`. It
    // shares the `imaging` bucket with clinical:ImagingStudy — the report and
    // the study it describes are the same part of the record picture, and
    // `solid:forClass` is minted from `rdfTypes[0]`, which is unchanged.
    expect(DATA_TYPES.imaging.rdfTypes).toEqual([
      NS.clinical + 'ImagingStudy',
      NS.clinical + 'ImagingReport',
    ]);
  });
});
