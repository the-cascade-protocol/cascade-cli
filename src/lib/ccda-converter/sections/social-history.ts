/**
 * Social history section (templateId 2.16.840.1.113883.10.20.22.2.17)
 * Structured extraction not yet implemented — narrative is preserved by main converter.
 */

import type { Quad } from 'n3';

export const SOCIAL_HISTORY_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.17';
export const SOCIAL_HISTORY_LOINC = '29762-2';

export function extractSocialHistoryQuads(
  _entries: any[],
  _patientUri: string,
  _sourceSystem: string,
): Quad[] {
  // Social history structured extraction is deferred; narrative is preserved separately.
  return [];
}
