/**
 * Extract implanted devices from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.23)
 * Minimal implementation — narrative is preserved by the main converter.
 */

import { NS, contentHashedUri } from '../../fhir-converter/types.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const DEVICES_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.23';
export const DEVICES_LOINC = '46264-8';

export function extractDeviceQuads(
  entries: any[],
  patientUri: string,
  sourceSystem: string,
): Quad[] {
  const quads: Quad[] = [];

  for (const entry of entries) {
    const supply = entry?.supply ?? entry;
    if (!supply) continue;

    const participant = Array.isArray(supply?.participant)
      ? supply.participant[0]
      : supply?.participant;
    const device = participant?.participantRole?.playingDevice ?? {};
    const codeEl = device?.code ?? {};
    const displayName = codeEl?.['@_displayName'] ?? codeEl?.displayName ??
      (typeof device?.manufacturerModelName === 'string' ? device.manufacturerModelName : '');

    if (!displayName) continue;

    const effTime = supply?.effectiveTime ?? {};
    const dateVal = effTime?.['@_value'] ?? effTime?.value ?? effTime?.low?.['@_value'] ?? '';
    const dateStr = dateVal.length >= 8
      ? `${dateVal.slice(0, 4)}-${dateVal.slice(4, 6)}-${dateVal.slice(6, 8)}`
      : dateVal;

    const sourceId = (() => {
      const idEl = Array.isArray(supply?.id) ? supply.id[0] : supply?.id;
      return idEl?.['@_extension'] ? `${idEl['@_root'] ?? ''}:${idEl['@_extension']}` : '';
    })();

    const uri = contentHashedUri('Device', {
      patient: patientUri,
      displayName: displayName.toLowerCase(),
      date: dateStr || undefined,
    }, sourceId || undefined);

    const subj = namedNode(uri);
    quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'ImplantedDevice')));
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'deviceName'), literal(displayName)));
    if (dateStr) quads.push(makeQuad(subj, namedNode(NS.health + 'effectiveDate'), literal(dateStr)));
    if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
  }

  return quads;
}
