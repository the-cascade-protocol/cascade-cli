import type { FieldDropManifest } from '../types.js';

/**
 * What `convertLaboratoryReport` does not emit.
 *
 * `presentedForm` is the report as the lab rendered it. The pod describes
 * reports whose content it cannot show.
 */
export const DIAGNOSTIC_REPORT_DROPS: FieldDropManifest = {
  resourceType: 'DiagnosticReport',
  provenance:
    'Differential run over test-fixtures/field-coverage/diagnosticreport.json; matches the field census taken over 62 Epic R4 DiagnosticReports.',
  drops: {
    'DiagnosticReport.meta': {
      disposition: 'acknowledged',
      reason:
        "FHIR server bookkeeping (versionId, lastUpdated) about the resource's life on a server, not about the patient.",
    },
    'DiagnosticReport.identifier': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The accession number. The cross-transport join key for a report, and the reason one report pulled twice cannot be recognised as one report.',
    },
    'DiagnosticReport.subject': {
      disposition: 'acknowledged',
      reason: "A pod holds one person's records, so the subject link is the pod itself.",
    },
    'DiagnosticReport.resultsInterpreter': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The clinician who signed the interpretation, which is a different person from the performing laboratory that clinical:providerName currently carries.',
    },
    'DiagnosticReport.specimen': {
      disposition: 'pending',
      backlog: '3.256',
      reason: 'What was sampled. Same gap as Observation.specimen, one level up.',
    },
    'DiagnosticReport.conclusion': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The narrative interpretation of the panel — the sentence a clinician wrote about what the numbers mean.',
    },
    'DiagnosticReport.conclusionCode': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The coded finding the report concludes. It is the machine-readable half of the conclusion and the part a query can act on.',
    },
    'DiagnosticReport.presentedForm': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The rendered report itself (usually a PDF). Keeping it needs a blob-storage decision rather than a converter line, which is why this is sequenced separately from the other drops here.',
    },
    'DiagnosticReport.category[0].text': {
      disposition: 'acknowledged',
      reason:
        'Read only when the category states no coding. With a coding present the code is emitted as clinical:reportCategory and the text restates it.',
    },
    'DiagnosticReport.performer[0].reference': {
      disposition: 'acknowledged',
      reason:
        'Practitioner and Organization resources are not imported as records, so the reference would dangle. The display is emitted as clinical:providerName.',
    },
  },
};
