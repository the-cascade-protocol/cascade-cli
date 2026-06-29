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

/**
 * Build a map of narrative element ID -> plain text from a section's <text>
 * block. Epic medication entries put the human-readable drug name in the
 * narrative (e.g. <paragraph ID="med12">cholecalciferol (VITAMIN D-3) ...) and
 * reference it from the entry's
 * consumable/manufacturedMaterial/code/originalText/reference/@value="#med12".
 * Resolving the reference recovers the drug name the structured code omits.
 */
function buildNarrativeIdMap(sectionText: any): Record<string, string> {
  const map: Record<string, string> = {};
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const id = node['@_ID'];
    if (typeof id === 'string' && id) {
      const text = collapseText(node);
      if (text) map[id] = text;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('@_')) continue;
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(sectionText);
  return map;
}

/** Collect all #text descendants of a parsed node into a single trimmed string. */
function collapseText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collapseText).filter(Boolean).join(' ').trim();
  if (typeof node === 'object') {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('@_')) continue;
      const t = collapseText(value);
      if (t) parts.push(t);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

/** Resolve a manufacturedMaterial code's originalText/reference/@value (#medNN). */
function resolveNarrativeName(codeEl: any, narrativeIdMap: Record<string, string>): string {
  const ref =
    codeEl?.originalText?.reference?.['@_value'] ??
    codeEl?.originalText?.reference?.value ?? '';
  if (typeof ref === 'string' && ref.startsWith('#')) {
    const name = narrativeIdMap[ref.slice(1)];
    if (name) return name;
  }
  // originalText may carry the text inline rather than a reference.
  const inline = codeEl?.originalText?.['#text'] ??
    (typeof codeEl?.originalText === 'string' ? codeEl.originalText : '');
  return typeof inline === 'string' ? inline.trim() : '';
}

export function extractMedicationQuads(
  entries: any[],
  patientUri: string,
  sourceSystem: string,
  sectionText?: any,
): Quad[] {
  const quads: Quad[] = [];
  const rxNormOid = '2.16.840.1.113883.6.88';
  const narrativeIdMap = buildNarrativeIdMap(sectionText);

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

    if (isRxNorm && code) quads.push(makeQuad(subj, namedNode(NS.clinical + 'rxNormCode'), namedNode(resolveCodeUri(rxNormOid, code))));
    if (displayName) quads.push(makeQuad(subj, namedNode(NS.clinical + 'drugName'), literal(displayName)));
    if (startDate) quads.push(makeQuad(subj, namedNode(NS.health + 'startDate'), literal(startDate)));
    if (dose) quads.push(makeQuad(subj, namedNode(NS.clinical + 'dosage'), literal(dose)));
    if (doseUnit) quads.push(makeQuad(subj, namedNode(NS.health + 'doseUnit'), literal(doseUnit)));
    if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
  }

  return quads;
}
