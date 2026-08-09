/**
 * Extract conditions/problems from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.5.1)
 */

import { NS } from '../../fhir-converter/types.js';
import { firstOf, listOf } from '../multivalued.js';
import { ccdaRecordUri, ccdaSourceId } from '../record-identity.js';
import { resolveCodeUri } from '../code-systems.js';
import { ccdaDateQuad } from '../dates.js';
import { buildNarrativeIdMap, resolveNarrativeName } from '../narrative-reference.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const PROBLEMS_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.5.1';
export const PROBLEMS_LOINC = '11450-4';

export function extractProblemQuads(
  entries: any[],
  sourceSystem: string,
  sectionText?: any,
  _importedAt?: string,
  warnings?: string[],
): Quad[] {
  const quads: Quad[] = [];
  const snomedOid = '2.16.840.1.113883.6.96';
  const icd10Oid = '2.16.840.1.113883.6.90';
  const narrativeIdMap = buildNarrativeIdMap(sectionText);

  for (const entry of entries) {
    // Conditions are inside an act/observation
    // entry.act is always an array from fast-xml-parser's isArray config — unwrap first element
    const act = firstOf<any>(entry?.act) ?? entry;
    const entryRelArr = listOf<any>(act?.entryRelationship);
    const obs = entryRelArr.flatMap((er: any) => listOf<any>(er?.observation));
    const obsArr = obs.length > 0 ? obs : (act?.observation ? listOf<any>(act.observation) : [act]);

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

      // Same recovery as the results section: when neither the value nor its
      // translations name the condition, the name is usually in the section
      // narrative, referenced from `<value><originalText><reference value="#id"/>`.
      // `health:conditionName` is `sh:minCount 1`, so reading `@displayName` only
      // meant an invalid record for a problem the document named in words.
      // Unresolvable stays empty and emits nothing.
      const conditionName = displayName || resolveNarrativeName(valueEl, narrativeIdMap);

      const isSnomed = codeSystem.includes('6.96') || codeSystem === snomedOid;
      const isIcd10 = codeSystem.includes('6.90') || codeSystem === icd10Oid;

      // Status from entryRelationship. `statedStatus` and `status` are kept
      // apart on purpose: `status` carries the 'active' DEFAULT and is what the
      // record DISPLAYS, while only `statedStatus` — what the source actually
      // said — may enter the identity key. A placeholder default in a key turns
      // "we do not know" into "these are the same record", and a content tier
      // that succeeds with a constant is indistinguishable from one that fails
      // except that it merges.
      //
      // `<entryRelationship>` is a repeatable element and is therefore an ARRAY.
      // This read used to be `observation?.entryRelationship?.observation`,
      // which is `undefined` on an array — so `statedStatus` was ALWAYS empty
      // and `status` was ALWAYS the 'active' default, on every document, whether
      // or not the source said the problem was resolved. A resolved problem
      // imported as active. The status observation is found the same way the
      // condition observation above is.
      const statusObs = listOf<any>(observation?.entryRelationship)
        .flatMap((er: any) => listOf<any>(er?.observation))
        .find((o: any) => o?.value != null);
      const statusValue = statusObs?.value;
      const statedStatus = statusValue?.['@_displayName'] ?? statusValue?.displayName ?? '';
      const status = statedStatus || 'active';

      // Onset date
      const effectiveTime = observation?.effectiveTime ?? act?.effectiveTime ?? {};
      const onsetVal =
        effectiveTime?.low?.['@_value'] ?? effectiveTime?.low?.value ??
        effectiveTime?.['@_value'] ?? effectiveTime?.value ?? '';
      const onsetDate = onsetVal.length >= 8
        ? `${onsetVal.slice(0, 4)}-${onsetVal.slice(4, 6)}-${onsetVal.slice(6, 8)}`
        : onsetVal;

      const sourceId = ccdaSourceId(observation?.id);

      const uri = ccdaRecordUri({
        type: 'Condition',
        sourceId,
        content: {
          snomedCode: isSnomed ? code : undefined,
          icd10Code: isIcd10 ? code : undefined,
          // The STRUCTURED name only. A narrative-recovered name is emitted but
          // deliberately kept out of the key, for the reason spelled out in
          // `labs.ts`: widening it re-mints every record that gains one.
          conditionName: displayName || undefined,
          onsetDate: onsetDate || undefined,
          // Serialized as health:status, so it belongs in the key: "active" and
          // "resolved" are two different claims about a patient, and the FHIR
          // Condition key includes clinicalStatus for exactly that reason. The
          // STATED value only — never the default.
          status: statedStatus ? statedStatus.toLowerCase() : undefined,
        },
        source: entry,
        warnings,
        label: 'C-CDA problem',
      });

      const subj = namedNode(uri);
      quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.health + 'ConditionRecord')));
      quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));

      if (isSnomed && code) quads.push(makeQuad(subj, namedNode(NS.health + 'snomedCode'), namedNode(resolveCodeUri(snomedOid, code))));
      if (isIcd10 && code) quads.push(makeQuad(subj, namedNode(NS.health + 'icd10Code'), namedNode(resolveCodeUri(icd10Oid, code))));
      if (conditionName) quads.push(makeQuad(subj, namedNode(NS.health + 'conditionName'), literal(conditionName)));
      if (status) quads.push(makeQuad(subj, namedNode(NS.health + 'status'), literal(status.toLowerCase())));
      // Typed from the raw effectiveTime; see `dates.ts`.
      const onsetQuad = ccdaDateQuad(uri, NS.health + 'onsetDate', onsetVal);
      if (onsetQuad) quads.push(onsetQuad);
      if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
    }
  }

  return quads;
}
