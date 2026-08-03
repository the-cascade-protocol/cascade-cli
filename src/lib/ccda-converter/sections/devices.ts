/**
 * Extract implanted devices from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.23)
 * Minimal implementation — narrative is preserved by the main converter.
 */

import { NS } from '../../fhir-converter/types.js';
import { firstOf } from '../multivalued.js';
import { ccdaRecordUri, ccdaSourceId } from '../record-identity.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const DEVICES_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.23';
export const DEVICES_LOINC = '46264-8';

export function extractDeviceQuads(
  entries: any[],
  sourceSystem: string,
  _sectionText?: any,
  _importedAt?: string,
  warnings?: string[],
): Quad[] {
  const quads: Quad[] = [];

  for (const entry of entries) {
    // `<supply>` is a repeatable element and is therefore an ARRAY (see
    // `multivalued.ts`). This used to be `entry?.supply ?? entry`, which yielded
    // the array, so `supply.participant` and `supply.effectiveTime` were both
    // `undefined`, the device had no name, and the `if (!displayName) continue`
    // below dropped EVERY implanted device without a word. Measured on a
    // one-device section: 0 quads before, 5 after.
    const supply = firstOf<any>(entry?.supply) ?? entry;
    if (!supply) continue;

    const participant = firstOf<any>(supply?.participant);
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

    // The <supply> carries the id in most exports; the device participantRole
    // carries its own (typically the UDI) where the supply does not.
    const sourceId = ccdaSourceId(supply?.id) ?? ccdaSourceId(participant?.participantRole?.id);

    const uri = ccdaRecordUri({
      type: 'Device',
      sourceId,
      content: {
        displayName: displayName.toLowerCase(),
        date: dateStr || undefined,
      },
      source: entry,
      warnings,
      label: 'C-CDA implanted device',
    });

    const subj = namedNode(uri);
    quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'ImplantedDevice')));
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'deviceName'), literal(displayName)));
    if (dateStr) quads.push(makeQuad(subj, namedNode(NS.health + 'effectiveDate'), literal(dateStr)));
    if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
  }

  return quads;
}
