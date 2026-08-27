import type { FieldDropManifest } from '../types.js';

/**
 * What `convertObservationLab` does not emit.
 *
 * `status` used to head this list: `amended` and `final` produced byte-identical
 * records, so a corrected result was indistinguishable from an original one. It
 * is emitted now, and the entry is gone rather than annotated — a manifest that
 * kept a fixed item as history would be describing a loss that no longer
 * happens.
 */
export const OBSERVATION_DROPS: FieldDropManifest = {
  resourceType: 'Observation',
  provenance:
    'Differential run over test-fixtures/field-coverage/observation-lab.json; matches the field census taken over 659 Epic R4 Observations.',
  drops: {
    'Observation.meta': {
      disposition: 'acknowledged',
      reason:
        "FHIR server bookkeeping (versionId, lastUpdated) about the resource's life on a server, not about the patient.",
    },
    'Observation.identifier': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The lab\'s own order/filler number. The same cross-transport join key Encounter.identifier is: without it, one result arriving twice cannot be recognised as one result.',
    },
    'Observation.subject': {
      disposition: 'acknowledged',
      reason:
        "A pod holds one person's records, so the subject link is the pod itself. A reference to a Patient resource the pod does not hold would dangle.",
    },
    'Observation.issued': {
      disposition: 'acknowledged',
      reason:
        'Read only as a fallback for health:performedDate when the resource states no effective time. When both are present the effective instant is the clinically meaningful one and wins.',
    },
    'Observation.note': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The free text where a lab explains a flagged value ("specimen hemolyzed", "confirmed on repeat"). Reading a number without it can mean reading it wrongly.',
    },
    'Observation.specimen': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'What was sampled. It is already part of the lab identity key, so it decides which results merge while never appearing as a fact a reader can see.',
    },
    'Observation.valueQuantity.system': {
      disposition: 'acknowledged',
      reason:
        'Names the code system for valueQuantity.code. Carrying it while the code itself is not stored would state a system for nothing.',
    },
    'Observation.valueQuantity.code': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The UCUM unit code. health:resultUnit carries the display unit, which is what a person reads and what a machine cannot safely compare ("mg/dL" typed three ways is three units).',
    },
    'Observation.interpretation[0].text': {
      disposition: 'acknowledged',
      reason:
        'Redundant alternative: the coded interpretation is emitted as health:interpretation and the text restates it.',
    },
    'Observation.referenceRange[0].text': {
      disposition: 'acknowledged',
      reason:
        'Read only when the range states neither low nor high. With both present the numeric bounds are emitted and the text repeats them.',
    },
    'Observation.referenceRange[0].type': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'Which meaning the range has (normal range, therapeutic target, critical). A treatment target read as a normal range says the opposite of what it means.',
    },
    'Observation.referenceRange[1]': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'Only referenceRange[0] is read. A result carrying population-specific ranges keeps whichever the server happened to list first.',
    },
    'Observation.performer[0].reference': {
      disposition: 'acknowledged',
      reason:
        'Practitioner and Organization resources are not imported as records, so the reference would dangle. The display is emitted as clinical:providerName by the provenance pass.',
    },
  },
};
