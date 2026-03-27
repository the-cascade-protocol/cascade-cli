/**
 * Extract vital signs from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.4.1)
 */

import { NS, contentHashedUri } from '../../fhir-converter/types.js';
import { resolveCodeUri } from '../code-systems.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const VITALS_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.4.1';
export const VITALS_LOINC = '8716-3';

export function extractVitalQuads(
  entries: any[],
  patientUri: string,
  sourceSystem: string,
): Quad[] {
  const quads: Quad[] = [];
  const loincOid = '2.16.840.1.113883.6.1';

  for (const entry of entries) {
    // Vitals may be in organizer/component
    const observations: any[] = [];
    if (entry?.organizer?.component) {
      const comps = Array.isArray(entry.organizer.component)
        ? entry.organizer.component
        : [entry.organizer.component];
      for (const comp of comps) {
        if (comp?.observation) observations.push(comp.observation);
      }
    } else if (entry?.observation) {
      observations.push(entry.observation);
    }

    for (const obs of observations) {
      if (!obs) continue;

      const codeEl = obs?.code ?? {};
      const loincCode = codeEl?.['@_code'] ?? codeEl?.code ?? '';
      const codeSystem = codeEl?.['@_codeSystem'] ?? codeEl?.codeSystem ?? '';
      const displayName = codeEl?.['@_displayName'] ?? codeEl?.displayName ?? '';
      const isLoinc = codeSystem.includes('6.1') || codeSystem === loincOid;

      const effTime = obs?.effectiveTime;
      const dateVal =
        effTime?.['@_value'] ?? effTime?.value ??
        effTime?.low?.['@_value'] ?? effTime?.low?.value ?? '';
      const dateStr = dateVal.length >= 8
        ? `${dateVal.slice(0, 4)}-${dateVal.slice(4, 6)}-${dateVal.slice(6, 8)}`
        : dateVal;

      const valueEl = obs?.value ?? {};
      const value = valueEl?.['@_value'] ?? valueEl?.value ?? '';
      const unit = valueEl?.['@_unit'] ?? valueEl?.unit ?? '';

      const sourceId = (() => {
        const idEl = Array.isArray(obs?.id) ? obs.id[0] : obs?.id;
        return idEl?.['@_extension'] ? `${idEl['@_root'] ?? ''}:${idEl['@_extension']}` : '';
      })();

      const uri = contentHashedUri('VitalSign', {
        patient: patientUri,
        loincCode: isLoinc ? loincCode : undefined,
        displayName: displayName || undefined,
        date: dateStr || undefined,
        value: value || undefined,
      }, sourceId || undefined);

      const subj = namedNode(uri);
      quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'VitalSign')));
      quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));

      if (isLoinc && loincCode) quads.push(makeQuad(subj, namedNode(NS.health + 'testCode'), namedNode(resolveCodeUri(loincOid, loincCode))));
      if (displayName) quads.push(makeQuad(subj, namedNode(NS.health + 'vitalName'), literal(displayName)));
      if (dateStr) quads.push(makeQuad(subj, namedNode(NS.health + 'effectiveDate'), literal(dateStr)));
      if (value) quads.push(makeQuad(subj, namedNode(NS.health + 'value'), literal(value)));
      if (unit) quads.push(makeQuad(subj, namedNode(NS.health + 'unit'), literal(unit)));
      if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
    }
  }

  return quads;
}
