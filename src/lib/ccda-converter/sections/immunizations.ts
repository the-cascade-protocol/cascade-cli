/**
 * Extract immunizations from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.2.1)
 */

import { NS } from '../../fhir-converter/types.js';
import { firstOf } from '../multivalued.js';
import { ccdaRecordUri, ccdaSourceId } from '../record-identity.js';
import { resolveCodeUri } from '../code-systems.js';
import { ccdaDateQuad } from '../dates.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const IMMUNIZATIONS_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.2.1';
export const IMMUNIZATIONS_LOINC = '11369-6';

export function extractImmunizationQuads(
  entries: any[],
  sourceSystem: string,
  _sectionText?: any,
  _importedAt?: string,
  warnings?: string[],
): Quad[] {
  const quads: Quad[] = [];

  for (const entry of entries) {
    const sa = firstOf<any>(entry?.substanceAdministration) ?? entry;
    if (!sa) continue;

    // Extract vaccine code
    const material = sa?.consumable?.manufacturedProduct?.manufacturedMaterial;
    const codeEl = material?.code ?? {};
    const cvxOid = '2.16.840.1.113883.12.292';
    const codeSystem = codeEl?.['@_codeSystem'] ?? codeEl?.codeSystem ?? '';
    const code = codeEl?.['@_code'] ?? codeEl?.code ?? '';
    const displayName = codeEl?.['@_displayName'] ?? codeEl?.displayName ?? 'Unknown Vaccine';

    // Extract date
    const effectiveTime = sa?.effectiveTime ?? {};
    const dateVal =
      effectiveTime?.['@_value'] ?? effectiveTime?.value ??
      effectiveTime?.low?.['@_value'] ?? effectiveTime?.low?.value ?? '';
    const dateStr = dateVal.length >= 8
      ? `${dateVal.slice(0, 4)}-${dateVal.slice(4, 6)}-${dateVal.slice(6, 8)}`
      : dateVal;

    const sourceId = ccdaSourceId(sa?.id);

    const uri = ccdaRecordUri({
      type: 'Immunization',
      sourceId,
      content: {
        cvxCode: codeSystem.includes('292') || codeSystem === cvxOid ? code : undefined,
        // 'Unknown Vaccine' is a placeholder default, and a placeholder in an
        // identity key turns "we do not know" into "these are the same record".
        vaccineName: displayName !== 'Unknown Vaccine' ? displayName.toLowerCase() : undefined,
        date: dateStr,
      },
      source: entry,
      warnings,
      label: 'C-CDA immunization',
    });

    const subj = namedNode(uri);
    quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.health + 'ImmunizationRecord')));
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));
    quads.push(makeQuad(subj, namedNode(NS.health + 'vaccineName'), literal(displayName)));

    if (code && (codeSystem.includes('292') || codeSystem === cvxOid)) {
      quads.push(makeQuad(subj, namedNode(NS.health + 'cvxCode'), namedNode(resolveCodeUri(cvxOid, code))));
    }
    // Typed from the raw effectiveTime; see `dates.ts`.
    const administrationQuad = ccdaDateQuad(uri, NS.health + 'administrationDate', dateVal, warnings);
    if (administrationQuad) quads.push(administrationQuad);
    if (sourceId) {
      quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
    }
  }

  return quads;
}
