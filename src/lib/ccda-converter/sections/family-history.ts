/**
 * Extract family history from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.15)
 * Minimal implementation — narrative is preserved by the main converter.
 */

import { NS, contentHashedUri } from '../../fhir-converter/types.js';
import { resolveCodeUri } from '../code-systems.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const FAMILY_HISTORY_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.15';
export const FAMILY_HISTORY_LOINC = '10157-6';

export function extractFamilyHistoryQuads(
  entries: any[],
  patientUri: string,
  sourceSystem: string,
): Quad[] {
  const quads: Quad[] = [];
  const snomedOid = '2.16.840.1.113883.6.96';

  for (const entry of entries) {
    const organizer = entry?.organizer ?? entry;
    if (!organizer) continue;

    // Family member relationship
    const subject = organizer?.subject?.relatedSubject;
    const relationCode = subject?.code ?? {};
    const relation = relationCode?.['@_displayName'] ?? relationCode?.displayName ?? '';

    // Observations within the organizer
    const components = Array.isArray(organizer?.component) ? organizer.component : [];
    for (const comp of components) {
      const obs = comp?.observation;
      if (!obs) continue;

      const valueEl = obs?.value ?? {};
      const code = valueEl?.['@_code'] ?? valueEl?.code ?? '';
      const codeSystem = valueEl?.['@_codeSystem'] ?? valueEl?.codeSystem ?? '';
      const displayName = valueEl?.['@_displayName'] ?? valueEl?.displayName ?? '';
      const isSnomed = codeSystem.includes('6.96') || codeSystem === snomedOid;

      if (!displayName && !code) continue;

      const sourceId = (() => {
        const idEl = Array.isArray(obs?.id) ? obs.id[0] : obs?.id;
        return idEl?.['@_extension'] ? `${idEl['@_root'] ?? ''}:${idEl['@_extension']}` : '';
      })();

      const uri = contentHashedUri('FamilyHistory', {
        patient: patientUri,
        relation: relation || undefined,
        condition: displayName || undefined,
        code: code || undefined,
      }, sourceId || undefined);

      const subj = namedNode(uri);
      quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.health + 'FamilyHistoryRecord')));
      quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));
      if (relation) quads.push(makeQuad(subj, namedNode(NS.health + 'familyMember'), literal(relation)));
      if (displayName) quads.push(makeQuad(subj, namedNode(NS.health + 'conditionName'), literal(displayName)));
      if (isSnomed && code) quads.push(makeQuad(subj, namedNode(NS.health + 'snomedCode'), namedNode(resolveCodeUri(snomedOid, code))));
      if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
    }
  }

  return quads;
}
