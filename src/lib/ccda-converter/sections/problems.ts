/**
 * Extract conditions/problems from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.5.1)
 */

import { NS, contentHashedUri } from '../../fhir-converter/types.js';
import { resolveCodeUri } from '../code-systems.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const PROBLEMS_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.5.1';
export const PROBLEMS_LOINC = '11450-4';

export function extractProblemQuads(
  entries: any[],
  patientUri: string,
  sourceSystem: string,
): Quad[] {
  const quads: Quad[] = [];
  const snomedOid = '2.16.840.1.113883.6.96';
  const icd10Oid = '2.16.840.1.113883.6.90';

  for (const entry of entries) {
    // Conditions are inside an act/observation
    // entry.act is always an array from fast-xml-parser's isArray config — unwrap first element
    const actRaw = entry?.act;
    const act = Array.isArray(actRaw) ? actRaw[0] : (actRaw ?? entry);
    const entryRelArr = Array.isArray(act?.entryRelationship) ? act.entryRelationship : (act?.entryRelationship ? [act.entryRelationship] : []);
    const obs = entryRelArr.flatMap((er: any) => {
      const o = er?.observation;
      return Array.isArray(o) ? o : (o ? [o] : []);
    });
    const obsArr = obs.length > 0 ? obs : (act?.observation ? (Array.isArray(act.observation) ? act.observation : [act.observation]) : [act]);

    for (const observation of obsArr) {
      if (!observation?.code && !observation?.value) continue;

      // The condition code is typically in <value> not <code> for problem observations
      const valueEl = observation?.value ?? observation?.code ?? {};
      const code = valueEl?.['@_code'] ?? valueEl?.code ?? '';
      const codeSystem = valueEl?.['@_codeSystem'] ?? valueEl?.codeSystem ?? '';
      // Epic MyChart omits displayName on the value element itself; it's in translation children
      const firstTranslation = (() => {
        const t = valueEl?.translation;
        return Array.isArray(t) ? t[0] : t;
      })();
      const displayName =
        valueEl?.['@_displayName'] ?? valueEl?.displayName ??
        firstTranslation?.['@_displayName'] ?? firstTranslation?.displayName ?? '';

      const isSnomed = codeSystem.includes('6.96') || codeSystem === snomedOid;
      const isIcd10 = codeSystem.includes('6.90') || codeSystem === icd10Oid;

      // Status from entryRelationship
      const statusObs = observation?.entryRelationship?.observation;
      const statusValue = (Array.isArray(statusObs) ? statusObs[0] : statusObs)?.value;
      const status = statusValue?.['@_displayName'] ?? statusValue?.displayName ?? 'active';

      // Onset date
      const effectiveTime = observation?.effectiveTime ?? act?.effectiveTime ?? {};
      const onsetVal =
        effectiveTime?.low?.['@_value'] ?? effectiveTime?.low?.value ??
        effectiveTime?.['@_value'] ?? effectiveTime?.value ?? '';
      const onsetDate = onsetVal.length >= 8
        ? `${onsetVal.slice(0, 4)}-${onsetVal.slice(4, 6)}-${onsetVal.slice(6, 8)}`
        : onsetVal;

      const sourceId = (() => {
        const idEl = Array.isArray(observation?.id) ? observation.id[0] : observation?.id;
        return idEl?.['@_extension'] ? `${idEl['@_root'] ?? ''}:${idEl['@_extension']}` : '';
      })();

      const uri = contentHashedUri('Condition', {
        patient: patientUri,
        snomedCode: isSnomed ? code : undefined,
        icd10Code: isIcd10 ? code : undefined,
        conditionName: displayName || undefined,
        onsetDate: onsetDate || undefined,
      }, sourceId || undefined);

      const subj = namedNode(uri);
      quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.health + 'ConditionRecord')));
      quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));

      if (isSnomed && code) quads.push(makeQuad(subj, namedNode(NS.health + 'snomedCode'), namedNode(resolveCodeUri(snomedOid, code))));
      if (isIcd10 && code) quads.push(makeQuad(subj, namedNode(NS.health + 'icd10Code'), namedNode(resolveCodeUri(icd10Oid, code))));
      if (displayName) quads.push(makeQuad(subj, namedNode(NS.health + 'conditionName'), literal(displayName)));
      if (status) quads.push(makeQuad(subj, namedNode(NS.health + 'status'), literal(status.toLowerCase())));
      if (onsetDate) quads.push(makeQuad(subj, namedNode(NS.health + 'onsetDate'), literal(onsetDate)));
      if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
    }
  }

  return quads;
}
