/**
 * A prescribed dose is a dose, and the FHIR importer used to read only half of
 * the resources that state one.
 *
 * FHIR R4 gives `MedicationStatement` a `dosage` array and `MedicationRequest` a
 * `dosageInstruction` array. They are the SAME `Dosage` datatype with the same
 * `text`, `route` and `timing` children; only the field name differs. The
 * converter read `resource.dosage` alone, so every MedicationRequest — every
 * prescription — reached the pod with no dose at all.
 *
 * WHY THAT IS WORSE THAN A MISSING TRIPLE. Dose is deliberately stripped out of
 * the medication identity key, so "sertraline 50 mg" and "sertraline 100 mg" are
 * one drug as far as matching is concerned; what is supposed to keep the two
 * apart is the dose-disagreement check, which raises a conflict a person answers.
 * With both doses absent that check compared two undefineds, found nothing to
 * disagree about, and merged the pair as a near-duplicate. A dose change
 * disappeared with no conflict, no warning and no trace — while the identical
 * change expressed as a MedicationStatement raised its conflict correctly. Which
 * of two ordinary FHIR shapes the source used decided whether the change
 * survived the import.
 *
 * All fixtures are synthetic.
 */

import { describe, it, expect } from 'vitest';
import type { Quad } from 'n3';
import { convertMedicationStatement } from '../src/lib/fhir-converter/converters-clinical.js';
import { runReconciliation } from '../src/lib/reconciler.js';
import { NS } from '../src/lib/fhir-converter/types.js';

/** A MedicationRequest whose dose rides on `dosageInstruction`. */
function request(id: string, doseText: string): any {
  return {
    resourceType: 'MedicationRequest',
    id,
    status: 'active',
    intent: 'order',
    medicationCodeableConcept: {
      coding: [
        {
          system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
          code: '312940',
          display: 'Sertraline 50 MG Oral Tablet',
        },
      ],
      text: 'Sertraline oral tablet',
    },
    subject: { reference: 'urn:uuid:patient-1' },
    authoredOn: '2025-02-11',
    dosageInstruction: [
      {
        text: doseText,
        route: { text: 'Oral' },
        timing: { repeat: { frequency: 1, period: 1, periodUnit: 'd' } },
      },
    ],
  };
}

/** The same drug as a MedicationStatement, whose dose rides on `dosage`. */
function statement(id: string, doseText: string): any {
  const r = request(id, doseText);
  r.resourceType = 'MedicationStatement';
  r.dosage = r.dosageInstruction;
  delete r.dosageInstruction;
  delete r.intent;
  return r;
}

function objectOf(quads: Quad[], predicate: string): string | undefined {
  return quads.find((q) => q.predicate.value === predicate)?.object.value;
}

describe('MedicationRequest.dosageInstruction is read like MedicationStatement.dosage', () => {
  it('carries the dose text, route and frequency off dosageInstruction', () => {
    const { _quads } = convertMedicationStatement(request('mr-1', '50 mg by mouth every morning'));
    expect(objectOf(_quads, NS.clinical + 'dosage')).toBe('50 mg by mouth every morning');
    expect(objectOf(_quads, NS.clinical + 'route')).toBe('Oral');
    expect(objectOf(_quads, NS.clinical + 'frequency')).toBe('once daily');
  });

  it('produces the same dose triple whichever of the two shapes stated it', () => {
    // The invariant the defect broke: the answer must not depend on the
    // transport. Compared as a triple rather than as "both are truthy", so a
    // reader that found the field but mangled the value still fails.
    const fromRequest = convertMedicationStatement(request('mr-1', '50 mg by mouth every morning'));
    const fromStatement = convertMedicationStatement(
      statement('ms-1', '50 mg by mouth every morning'),
    );
    expect(objectOf(fromRequest._quads, NS.clinical + 'dosage')).toBe(
      objectOf(fromStatement._quads, NS.clinical + 'dosage'),
    );
  });

  it('prefers the resource\'s own `dosage` when a resource somehow carries both', () => {
    const both = statement('ms-2', 'from dosage');
    both.dosageInstruction = [{ text: 'from dosageInstruction' }];
    const { _quads } = convertMedicationStatement(both);
    expect(objectOf(_quads, NS.clinical + 'dosage')).toBe('from dosage');
  });

  it('writes no dose triple when the resource states none', () => {
    const bare = request('mr-3', '');
    delete bare.dosageInstruction;
    const { _quads } = convertMedicationStatement(bare);
    expect(objectOf(_quads, NS.clinical + 'dosage')).toBeUndefined();
  });
});

describe('a dose change stated on an order raises a conflict rather than merging away', () => {
  const PREFIXES = `
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
`;

  /** Serialize a converted MedicationRequest as the pod would hold it. */
  function turtleFor(uri: string, doseText: string): string {
    const { _quads } = convertMedicationStatement(request('mr', doseText));
    const dose = objectOf(_quads, NS.clinical + 'dosage');
    return `${PREFIXES}
<${uri}> a clinical:Medication ;
  clinical:drugName "Sertraline oral tablet" ;
  clinical:rxNormCode <http://www.nlm.nih.gov/research/umls/rxnorm/312940> ;
  clinical:status "active" ;
${dose === undefined ? '' : `  clinical:dosage "${dose}" ;\n`}  clinical:provenanceClass "imported" .
`;
  }

  it('reports a clinical:dosage conflict for 50 mg against 100 mg', async () => {
    const result = await runReconciliation([
      { content: turtleFor('urn:m:a', '50 mg by mouth every morning'), systemName: 'Harborview' },
      { content: turtleFor('urn:m:b', '100 mg by mouth every morning'), systemName: 'Ridgecrest' },
    ]);

    expect(result.report.summary.conflictsUnresolved).toBe(1);
    const [t] = result.report.transformations as Array<{ conflictField?: string; resolved?: boolean }>;
    expect(t.conflictField).toBe('clinical:dosage');
    expect(t.resolved).toBe(false);
  });

  it('still merges silently when neither record states a dose, which is why the read matters', async () => {
    // The pre-fix outcome, reproduced deliberately: with no dose on either side
    // there is nothing to disagree about and the pair collapses. Reading
    // dosageInstruction is what moves a real prescription out of this branch.
    const noDose = (uri: string) => `${PREFIXES}
<${uri}> a clinical:Medication ;
  clinical:drugName "Sertraline oral tablet" ;
  clinical:rxNormCode <http://www.nlm.nih.gov/research/umls/rxnorm/312940> ;
  clinical:status "active" .
`;
    const result = await runReconciliation([
      { content: noDose('urn:m:a'), systemName: 'Harborview' },
      { content: noDose('urn:m:b'), systemName: 'Ridgecrest' },
    ]);

    expect(result.report.summary.conflictsUnresolved).toBe(0);
    expect(result.report.summary.finalRecordCount).toBe(1);
  });
});
