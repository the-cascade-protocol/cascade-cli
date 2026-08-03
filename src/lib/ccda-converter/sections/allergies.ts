/**
 * Extract allergies from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.6.1)
 */

import { NS } from '../../fhir-converter/types.js';
import { ccdaRecordUri, ccdaSourceId } from '../record-identity.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const ALLERGIES_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.6.1';
export const ALLERGIES_LOINC = '48765-2';

export function extractAllergyQuads(
  entries: any[],
  sourceSystem: string,
  _sectionText?: any,
  _importedAt?: string,
  warnings?: string[],
): Quad[] {
  const quads: Quad[] = [];

  for (const entry of entries) {
    // entry.act is always an array from fast-xml-parser's isArray config — unwrap first element
    const actRaw = entry?.act;
    const act = Array.isArray(actRaw) ? actRaw[0] : (actRaw ?? entry);
    // The allergy observation sits under `act/entryRelationship/observation` in
    // canonical C-CDA R2.1, and directly under `act/observation` in the looser
    // shape some exports (and this repo's own corpus fixture) use. BOTH have to
    // be walked, and `entryRelationship` is always an ARRAY from the parser's
    // isArray config — so `act?.entryRelationship?.observation` was always
    // `undefined` and the canonical nesting produced NO allergy record at all.
    // Measured on the previous build: a canonical allergy entry yielded zero
    // `health:AllergyRecord`s. `problems.ts` already walked it correctly; this
    // is the same walk.
    const entryRelArr = Array.isArray(act?.entryRelationship)
      ? act.entryRelationship
      : act?.entryRelationship ? [act.entryRelationship] : [];
    const nested = entryRelArr.flatMap((er: any) => {
      const o = er?.observation;
      return Array.isArray(o) ? o : (o ? [o] : []);
    });
    const direct = act?.observation
      ? (Array.isArray(act.observation) ? act.observation : [act.observation])
      : [];
    const obsArr = nested.length > 0 ? nested : (direct.length > 0 ? direct : [act]);

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

      // The allergy CONCERN act carries the id in most exports; the reaction
      // observation carries its own where the act does not.
      const sourceId = ccdaSourceId(act?.id) ?? ccdaSourceId(observation?.id);

      const uri = ccdaRecordUri({
        type: 'Allergy',
        sourceId,
        content: {
          allergenName: allergenName.toLowerCase(),
          // Serialized as health:allergySeverity, so it has to be in the key:
          // a "mild" and a "severe" reaction to one allergen are two claims,
          // and merging them lets whichever was read first decide.
          severity: severityCode ? severityCode.toLowerCase() : undefined,
        },
        source: entry,
        warnings,
        label: 'C-CDA allergy',
      });

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
