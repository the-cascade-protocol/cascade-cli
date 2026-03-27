/**
 * Extract encounters from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.22)
 * Minimal implementation — narrative is preserved by the main converter.
 */

import { NS, contentHashedUri } from '../../fhir-converter/types.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const ENCOUNTERS_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.22';
export const ENCOUNTERS_LOINC = '46240-8';

export function extractEncounterQuads(
  entries: any[],
  patientUri: string,
  sourceSystem: string,
): Quad[] {
  const quads: Quad[] = [];

  for (const entry of entries) {
    const enc = entry?.encounter ?? entry;
    if (!enc) continue;

    const codeEl = enc?.code ?? {};
    const displayName = codeEl?.['@_displayName'] ?? codeEl?.displayName ?? '';

    const effTime = enc?.effectiveTime ?? {};
    const dateVal =
      effTime?.['@_value'] ?? effTime?.value ?? effTime?.low?.['@_value'] ?? '';
    const dateStr = dateVal.length >= 8
      ? `${dateVal.slice(0, 4)}-${dateVal.slice(4, 6)}-${dateVal.slice(6, 8)}`
      : dateVal;

    const sourceId = (() => {
      const idEl = Array.isArray(enc?.id) ? enc.id[0] : enc?.id;
      return idEl?.['@_extension'] ? `${idEl['@_root'] ?? ''}:${idEl['@_extension']}` : '';
    })();

    const uri = contentHashedUri('Encounter', {
      patient: patientUri,
      displayName: displayName || undefined,
      date: dateStr || undefined,
    }, sourceId || undefined);

    const subj = namedNode(uri);
    quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'Encounter')));
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));
    if (displayName) quads.push(makeQuad(subj, namedNode(NS.cascade + 'encounterType'), literal(displayName)));
    if (dateStr) quads.push(makeQuad(subj, namedNode(NS.health + 'effectiveDate'), literal(dateStr)));
    if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
  }

  return quads;
}
