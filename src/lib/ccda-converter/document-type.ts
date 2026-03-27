/**
 * LOINC-based document type detection for C-CDA documents.
 */

export type CcdaDocumentType = 'summarization' | 'progress-note' | 'discharge-summary' | 'consultation-note' | 'other';

const LOINC_TO_DOC_TYPE: Record<string, CcdaDocumentType> = {
  '34133-9': 'summarization',     // Summarization of Episode Note
  '11488-4': 'consultation-note', // Consultation Note
  '18842-5': 'discharge-summary', // Discharge Summary
  '11506-3': 'progress-note',     // Progress Note
};

export function detectDocumentType(doc: any): CcdaDocumentType {
  const loincCode =
    doc?.ClinicalDocument?.code?.['@_code'] ??
    doc?.ClinicalDocument?.code?.code;
  return LOINC_TO_DOC_TYPE[loincCode] ?? 'other';
}
