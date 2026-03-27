/**
 * Extract procedures from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.7.1)
 */

import { NS, contentHashedUri } from '../../fhir-converter/types.js';
import { resolveCodeUri } from '../code-systems.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const PROCEDURES_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.7.1';
export const PROCEDURES_LOINC = '47519-4';

export function extractProcedureQuads(
  entries: any[],
  patientUri: string,
  sourceSystem: string,
): Quad[] {
  const quads: Quad[] = [];
  const snomedOid = '2.16.840.1.113883.6.96';
  const cptOid = '2.16.840.1.113883.6.12';

  for (const entry of entries) {
    const proc = entry?.procedure ?? entry?.act ?? entry;
    if (!proc) continue;

    const codeEl = proc?.code ?? {};
    const code = codeEl?.['@_code'] ?? codeEl?.code ?? '';
    const codeSystem = codeEl?.['@_codeSystem'] ?? codeEl?.codeSystem ?? '';
    const displayName = codeEl?.['@_displayName'] ?? codeEl?.displayName ?? '';

    const effTime = proc?.effectiveTime ?? {};
    const dateVal =
      effTime?.['@_value'] ?? effTime?.value ?? effTime?.low?.['@_value'] ?? '';
    const dateStr = dateVal.length >= 8
      ? `${dateVal.slice(0, 4)}-${dateVal.slice(4, 6)}-${dateVal.slice(6, 8)}`
      : dateVal;

    const sourceId = (() => {
      const idEl = Array.isArray(proc?.id) ? proc.id[0] : proc?.id;
      return idEl?.['@_extension'] ? `${idEl['@_root'] ?? ''}:${idEl['@_extension']}` : '';
    })();

    const uri = contentHashedUri('Procedure', {
      patient: patientUri,
      code: code || undefined,
      displayName: displayName || undefined,
      date: dateStr || undefined,
    }, sourceId || undefined);

    const subj = namedNode(uri);
    quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'Procedure')));
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));
    if (displayName) quads.push(makeQuad(subj, namedNode(NS.health + 'procedureName'), literal(displayName)));
    if (dateStr) quads.push(makeQuad(subj, namedNode(NS.health + 'performedDate'), literal(dateStr)));
    if (code) {
      if (codeSystem.includes('6.96') || codeSystem === snomedOid) {
        quads.push(makeQuad(subj, namedNode(NS.health + 'snomedCode'), namedNode(resolveCodeUri(snomedOid, code))));
      } else if (codeSystem.includes('6.12') || codeSystem === cptOid) {
        quads.push(makeQuad(subj, namedNode(NS.health + 'cptCode'), literal(code)));
      }
    }
    if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
  }

  return quads;
}
