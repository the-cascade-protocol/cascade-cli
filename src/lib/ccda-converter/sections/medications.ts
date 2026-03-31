/**
 * Extract medications from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.1.1)
 */

import { NS, contentHashedUri } from '../../fhir-converter/types.js';
import { resolveCodeUri } from '../code-systems.js';
import { lookupRxNormName } from '../rxnorm-lookup.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const MEDICATIONS_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.1.1';
export const MEDICATIONS_LOINC = '10160-0';

export function extractMedicationQuads(
  entries: any[],
  patientUri: string,
  sourceSystem: string,
): Quad[] {
  const quads: Quad[] = [];
  const rxNormOid = '2.16.840.1.113883.6.88';

  for (const entry of entries) {
    // entry.substanceAdministration is always an array from fast-xml-parser's isArray config — unwrap first element
    const saRaw = entry?.substanceAdministration;
    const sa = Array.isArray(saRaw) ? saRaw[0] : (saRaw ?? entry);
    if (!sa) continue;

    const material = sa?.consumable?.manufacturedProduct?.manufacturedMaterial;
    const codeEl = material?.code ?? {};
    const code = codeEl?.['@_code'] ?? codeEl?.code ?? '';
    const codeSystem = codeEl?.['@_codeSystem'] ?? codeEl?.codeSystem ?? '';
    const rawDisplayName =
      codeEl?.['@_displayName'] ?? codeEl?.displayName ??
      (typeof material?.name === 'string' ? material.name : material?.name?.['#text'] ?? '');
    const isRxNorm = codeSystem.includes('6.88') || codeSystem === rxNormOid;
    // Fall back to RxNorm lookup when the C-CDA entry omits displayName (common in Epic exports)
    const displayName = rawDisplayName || (isRxNorm && code ? lookupRxNormName(code) ?? '' : '');

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

    const sourceId = (() => {
      const idEl = Array.isArray(sa?.id) ? sa.id[0] : sa?.id;
      return idEl?.['@_extension'] ? `${idEl['@_root'] ?? ''}:${idEl['@_extension']}` : '';
    })();

    if (!displayName && !code) continue;

    const uri = contentHashedUri('Medication', {
      patient: patientUri,
      rxNormCode: isRxNorm ? code : undefined,
      medicationName: displayName ? displayName.toLowerCase() : undefined,
      startDate: startDate || undefined,
    }, sourceId || undefined);

    const subj = namedNode(uri);
    quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'Medication')));
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));

    if (isRxNorm && code) quads.push(makeQuad(subj, namedNode(NS.health + 'rxNormCode'), namedNode(resolveCodeUri(rxNormOid, code))));
    if (displayName) quads.push(makeQuad(subj, namedNode(NS.health + 'medicationName'), literal(displayName)));
    if (startDate) quads.push(makeQuad(subj, namedNode(NS.health + 'startDate'), literal(startDate)));
    if (dose) quads.push(makeQuad(subj, namedNode(NS.health + 'doseQuantity'), literal(dose)));
    if (doseUnit) quads.push(makeQuad(subj, namedNode(NS.health + 'doseUnit'), literal(doseUnit)));
    if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
  }

  return quads;
}
