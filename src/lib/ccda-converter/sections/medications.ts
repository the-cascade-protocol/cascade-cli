/**
 * Extract medications from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.1.1)
 *
 * Epic medication entries put the human-readable drug name in the section
 * narrative (e.g. `<paragraph ID="med12">cholecalciferol (VITAMIN D-3) …`) and
 * reference it from
 * `consumable/manufacturedMaterial/code/originalText/reference/@value="#med12"`.
 * The resolver that recovers it used to live here. It now lives in
 * `narrative-reference.ts`, unchanged, because the results, problems and
 * procedures sections need the identical resolution and were each about to grow
 * their own copy of it.
 */

import { NS } from '../../fhir-converter/types.js';
import { firstOf } from '../multivalued.js';
import { ccdaMedicationRecordUri, ccdaSourceId } from '../record-identity.js';
import { resolveCodeUri } from '../code-systems.js';
import { buildNarrativeIdMap, resolveNarrativeName } from '../narrative-reference.js';
import { lookupRxNormName } from '../rxnorm-lookup.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const MEDICATIONS_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.1.1';
export const MEDICATIONS_LOINC = '10160-0';

export function extractMedicationQuads(
  entries: any[],
  sourceSystem: string,
  sectionText?: any,
  _importedAt?: string,
  warnings?: string[],
): Quad[] {
  const quads: Quad[] = [];
  const rxNormOid = '2.16.840.1.113883.6.88';
  const narrativeIdMap = buildNarrativeIdMap(sectionText);

  for (const entry of entries) {
    const sa = firstOf<any>(entry?.substanceAdministration) ?? entry;
    if (!sa) continue;

    const material = sa?.consumable?.manufacturedProduct?.manufacturedMaterial;
    const codeEl = material?.code ?? {};
    const code = codeEl?.['@_code'] ?? codeEl?.code ?? '';
    const codeSystem = codeEl?.['@_codeSystem'] ?? codeEl?.codeSystem ?? '';
    // `<name>` is a repeatable element and is therefore an ARRAY, so the old
    // `material?.name?.['#text']` was `undefined` and a drug named only in
    // `<manufacturedMaterial><name>` fell through to the narrative/RxNorm tiers
    // below instead of using the name the source wrote.
    const materialName = firstOf<any>(material?.name);
    const rawDisplayName =
      codeEl?.['@_displayName'] ?? codeEl?.displayName ??
      (typeof materialName === 'string' ? materialName : materialName?.['#text'] ?? '');
    const isRxNorm = codeSystem.includes('6.88') || codeSystem === rxNormOid;
    // Drug name resolution order:
    //   1. structured code @displayName (rare in Epic exports)
    //   2. the narrative paragraph the code's originalText references (#medNN)
    //      — this is where Epic puts the human-readable name
    //   3. RxNorm ingredient lookup by RXCUI (only resolves ingredient-level codes)
    const narrativeName = resolveNarrativeName(codeEl, narrativeIdMap);
    const displayName =
      (typeof rawDisplayName === 'string' ? rawDisplayName.trim() : '') ||
      narrativeName ||
      (isRxNorm && code ? lookupRxNormName(code) ?? '' : '');

    // Extract dates
    const effectiveTimeRaw = sa?.effectiveTime;
    const effectiveTime = Array.isArray(effectiveTimeRaw) ? effectiveTimeRaw : [effectiveTimeRaw];
    const periodEl = effectiveTime.find((t: any) => t?.low || t?.['@_operator'] === 'A');
    const startVal = periodEl?.low?.['@_value'] ?? periodEl?.low?.value ?? '';
    const startDate = startVal.length >= 8
      ? `${startVal.slice(0, 4)}-${startVal.slice(4, 6)}-${startVal.slice(6, 8)}`
      : startVal;

    // Dose
    const doseEl = sa?.doseQuantity ?? {};
    const dose = doseEl?.['@_value'] ?? doseEl?.value ?? '';
    const doseUnit = doseEl?.['@_unit'] ?? doseEl?.unit ?? '';

    const sourceId = ccdaSourceId(sa?.id);

    if (!displayName && !code) continue;

    // `dose` and `doseUnit` are serialized but deliberately outside the key:
    // `medicationUri` is the ONE medication identity shared by every importer,
    // and it treats a dose change as a conflict on the same medication rather
    // than as a second medication. Changing that would move FHIR IRIs too.
    const uri = ccdaMedicationRecordUri({
      sourceId,
      fields: {
        rxNormCode: isRxNorm ? code : undefined,
        medicationName: displayName || undefined,
        startDate: startDate || undefined,
      },
      // The raw entry was NOT passed before, so the last identity tier landed on
      // the per-type sentinel rather than on a hash of the record.
      source: entry,
      warnings,
      label: 'C-CDA medication',
    });

    const subj = namedNode(uri);
    quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'Medication')));
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));

    if (isRxNorm && code) quads.push(makeQuad(subj, namedNode(NS.clinical + 'rxNormCode'), namedNode(resolveCodeUri(rxNormOid, code))));
    if (displayName) quads.push(makeQuad(subj, namedNode(NS.clinical + 'drugName'), literal(displayName)));
    if (startDate) quads.push(makeQuad(subj, namedNode(NS.health + 'startDate'), literal(startDate)));
    if (dose) quads.push(makeQuad(subj, namedNode(NS.clinical + 'dosage'), literal(dose)));
    if (doseUnit) quads.push(makeQuad(subj, namedNode(NS.health + 'doseUnit'), literal(doseUnit)));
    if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
  }

  return quads;
}
