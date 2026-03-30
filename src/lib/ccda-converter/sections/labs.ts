/**
 * Extract lab results from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.3.1)
 */

import { NS, contentHashedUri } from '../../fhir-converter/types.js';
import { resolveCodeUri } from '../code-systems.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const LABS_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.3.1';
export const LABS_LOINC = '30954-2';

export function extractLabQuads(
  entries: any[],
  patientUri: string,
  sourceSystem: string,
): Quad[] {
  const quads: Quad[] = [];
  const loincOid = '2.16.840.1.113883.6.1';

  for (const entry of entries) {
    // Labs may be wrapped in an organizer
    const observations: any[] = [];
    if (entry?.organizer?.component) {
      const comps = Array.isArray(entry.organizer.component)
        ? entry.organizer.component
        : [entry.organizer.component];
      for (const comp of comps) {
        if (comp?.observation) {
          const obs = Array.isArray(comp.observation) ? comp.observation : [comp.observation];
          observations.push(...obs);
        }
      }
    } else if (entry?.observation) {
      const obs = Array.isArray(entry.observation) ? entry.observation : [entry.observation];
      observations.push(...obs);
    }

    for (const obs of observations) {
      if (!obs) continue;

      const codeEl = obs?.code ?? {};
      const code = codeEl?.['@_code'] ?? codeEl?.code ?? '';
      const codeSystem = codeEl?.['@_codeSystem'] ?? codeEl?.codeSystem ?? '';
      const displayName = codeEl?.['@_displayName'] ?? codeEl?.displayName ?? '';
      const isLoinc = codeSystem.includes('6.1') || codeSystem === loincOid;

      // Extract effective date
      const effTime = obs?.effectiveTime;
      const dateVal =
        effTime?.['@_value'] ?? effTime?.value ??
        effTime?.low?.['@_value'] ?? effTime?.low?.value ?? '';
      const dateStr = dateVal.length >= 8
        ? `${dateVal.slice(0, 4)}-${dateVal.slice(4, 6)}-${dateVal.slice(6, 8)}`
        : dateVal;

      // Extract value
      const valueEl = obs?.value ?? {};
      const value = valueEl?.['@_value'] ?? valueEl?.value ?? valueEl?.['#text'] ?? '';
      const unit = valueEl?.['@_unit'] ?? valueEl?.unit ?? '';

      // Extract reference range
      const refRange = obs?.referenceRange?.observationRange;
      const refRangeText = refRange?.text?.['#text'] ?? refRange?.text ?? '';

      const sourceId = (() => {
        const idEl = Array.isArray(obs?.id) ? obs.id[0] : obs?.id;
        return idEl?.['@_extension'] ? `${idEl['@_root'] ?? ''}:${idEl['@_extension']}` : '';
      })();

      const uri = contentHashedUri('LabResult', {
        patient: patientUri,
        loincCode: isLoinc ? code : undefined,
        testName: displayName || undefined,
        date: dateStr || undefined,
      }, sourceId || undefined);

      const subj = namedNode(uri);
      quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.health + 'LabResultRecord')));
      quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));

      if (isLoinc && code) {
        quads.push(makeQuad(subj, namedNode(NS.health + 'testCode'), namedNode(resolveCodeUri(loincOid, code))));
      }
      if (displayName) quads.push(makeQuad(subj, namedNode(NS.health + 'testName'), literal(displayName)));
      if (dateStr) quads.push(makeQuad(subj, namedNode(NS.health + 'performedDate'), literal(dateStr)));
      if (value) quads.push(makeQuad(subj, namedNode(NS.health + 'resultValue'), literal(value)));
      if (unit) quads.push(makeQuad(subj, namedNode(NS.health + 'resultUnit'), literal(unit)));
      if (refRangeText) quads.push(makeQuad(subj, namedNode(NS.health + 'referenceRangeText'), literal(refRangeText)));
      if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
    }
  }

  return quads;
}
