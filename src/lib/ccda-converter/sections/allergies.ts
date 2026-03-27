/**
 * Extract allergies from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.6.1)
 */

import { NS, contentHashedUri } from '../../fhir-converter/types.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const ALLERGIES_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.6.1';
export const ALLERGIES_LOINC = '48765-2';

export function extractAllergyQuads(
  entries: any[],
  patientUri: string,
  sourceSystem: string,
): Quad[] {
  const quads: Quad[] = [];

  for (const entry of entries) {
    const act = entry?.act ?? entry;
    const obs = act?.entryRelationship?.observation ?? act?.observation ?? act;
    const obsArr = Array.isArray(obs) ? obs : [obs];

    for (const observation of obsArr) {
      // Allergen is typically in participant/playingEntity
      const participant = Array.isArray(observation?.participant)
        ? observation.participant[0]
        : observation?.participant;
      const playingEntity = participant?.participantRole?.playingEntity ?? {};
      const allergenCode = playingEntity?.code ?? {};
      const allergenName =
        typeof playingEntity?.name === 'string'
          ? playingEntity.name
          : playingEntity?.name?.['#text'] ??
            allergenCode?.['@_displayName'] ??
            allergenCode?.displayName ?? '';

      // Reaction/severity from entryRelationship
      const reactions = Array.isArray(observation?.entryRelationship)
        ? observation.entryRelationship
        : observation?.entryRelationship ? [observation.entryRelationship] : [];
      const severityObs = reactions.find(
        (r: any) => r?.observation?.code?.['@_code'] === 'SEV' || r?.typeCode === 'SUBJ',
      )?.observation;
      const severityCode =
        severityObs?.value?.['@_displayName'] ?? severityObs?.value?.displayName ?? '';

      if (!allergenName) continue;

      const sourceId = (() => {
        const idEl = Array.isArray(act?.id) ? act.id[0] : act?.id;
        return idEl?.['@_extension'] ? `${idEl['@_root'] ?? ''}:${idEl['@_extension']}` : '';
      })();

      const uri = contentHashedUri('Allergy', {
        patient: patientUri,
        allergenName: allergenName.toLowerCase(),
      }, sourceId || undefined);

      const subj = namedNode(uri);
      quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.health + 'AllergyRecord')));
      quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));
      quads.push(makeQuad(subj, namedNode(NS.health + 'allergen'), literal(allergenName)));

      if (severityCode) quads.push(makeQuad(subj, namedNode(NS.health + 'allergySeverity'), literal(severityCode.toLowerCase())));
      if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
    }
  }

  return quads;
}
