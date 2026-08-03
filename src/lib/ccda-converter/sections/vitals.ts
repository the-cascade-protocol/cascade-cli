/**
 * Extract vital signs from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.4.1)
 *
 * The VitalSignShape requires clinical:vitalType from a narrow sh:in enum and
 * keeps the reading under clinical:value. C-CDA vital observations carry a LOINC
 * code; we map that LOINC to the enum. Anything whose LOINC is not in the enum
 * (e.g. mean BP, head circumference, percentiles) is NOT a VitalSign per the
 * shape: rather than drop it, we re-route it to a health:LabResultRecord so the
 * value is preserved ("Cascade does not drop data"). This mirrors the FHIR
 * converter's convertObservationVital -> convertObservationLab fallback.
 */

import { NS, VITAL_LOINC_CODES } from '../../fhir-converter/types.js';
import { ccdaRecordUri, ccdaSourceId } from '../record-identity.js';
import { resolveCodeUri } from '../code-systems.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const VITALS_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.4.1';
export const VITALS_LOINC = '8716-3';

/**
 * Maps a VITAL_LOINC_CODES `type` to a clinical:vitalType the VitalSignShape's
 * sh:in enum accepts. A LOINC vital whose type is not listed here (mean BP,
 * percentiles, head circumference, intraocular pressure, body surface area, etc.)
 * is not a VitalSign per the shape and is routed to a lab result instead.
 * Kept in lockstep with VITAL_TYPE_TO_SHACL in the FHIR converter.
 */
const VITAL_TYPE_TO_SHACL: Record<string, string> = {
  heartRate: 'heartRate',
  bloodPressurePanel: 'bloodPressure',
  bloodPressureSystolic: 'bloodPressureSystolic',
  bloodPressureDiastolic: 'bloodPressureDiastolic',
  respiratoryRate: 'respiratoryRate',
  bodyTemperature: 'temperature',
  bodyTemperatureOral: 'temperature',
  oxygenSaturation: 'oxygenSaturation',
  bodyWeight: 'bodyWeight',
  bodyHeight: 'bodyHeight',
  bmi: 'bodyMassIndex',
};

export function extractVitalQuads(
  entries: any[],
  sourceSystem: string,
  _sectionText?: any,
  _importedAt?: string,
  warnings?: string[],
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
      const loincCode = codeEl?.['@_code'] ?? codeEl?.code ?? '';
      const codeSystem = codeEl?.['@_codeSystem'] ?? codeEl?.codeSystem ?? '';
      // Some C-CDA vitals carry the display in <originalText> rather than @displayName.
      const displayName =
        codeEl?.['@_displayName'] ?? codeEl?.displayName ??
        (typeof codeEl?.originalText === 'string'
          ? codeEl.originalText
          : codeEl?.originalText?.['#text'] ?? '');
      const isLoinc = codeSystem.includes('6.1') || codeSystem === loincOid;

      const effTime = obs?.effectiveTime;
      const dateVal =
        effTime?.['@_value'] ?? effTime?.value ??
        effTime?.low?.['@_value'] ?? effTime?.low?.value ?? '';
      const dateStr = dateVal.length >= 8
        ? `${dateVal.slice(0, 4)}-${dateVal.slice(4, 6)}-${dateVal.slice(6, 8)}`
        : dateVal;

      const valueEl = obs?.value ?? {};
      const value = valueEl?.['@_value'] ?? valueEl?.value ?? valueEl?.['#text'] ?? '';
      const unit = valueEl?.['@_unit'] ?? valueEl?.unit ?? '';

      const sourceId = ccdaSourceId(obs?.id);

      // Resolve a clinical:vitalType the VitalSignShape enum accepts.
      const vitalInfo = isLoinc && loincCode ? VITAL_LOINC_CODES[loincCode] : undefined;
      const shaclVitalType = vitalInfo ? VITAL_TYPE_TO_SHACL[vitalInfo.type] : undefined;

      if (!shaclVitalType) {
        // Not a VitalSign per the shape (no LOINC match, or a LOINC outside the
        // canonical enum). Preserve the value as a lab result rather than drop it.
        quads.push(...buildLabFallback({
          sourceSystem, loincCode, isLoinc, loincOid,
          displayName, dateStr, value, unit, sourceId, source: obs, warnings,
        }));
        continue;
      }

      const uri = ccdaRecordUri({
        type: 'VitalSign',
        sourceId,
        content: {
          loincCode: isLoinc ? loincCode : undefined,
          displayName: displayName || undefined,
          date: dateStr || undefined,
          value: value || undefined,
          // Serialized as clinical:unit and was outside the key: a weight of
          // "70 kg" and one of "70 lb" are different readings.
          unit: unit || undefined,
        },
        source: obs,
        warnings,
        label: 'C-CDA vital sign',
      });

      const subj = namedNode(uri);
      quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'VitalSign')));
      quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));

      // Required: vitalType (enum-valid).
      quads.push(makeQuad(subj, namedNode(NS.clinical + 'vitalType'), literal(shaclVitalType, namedNode(NS.xsd + 'string'))));
      // Value lives under clinical:value (untyped in the shape; string is fine).
      if (value) quads.push(makeQuad(subj, namedNode(NS.clinical + 'value'), literal(String(value))));
      if (unit) quads.push(makeQuad(subj, namedNode(NS.clinical + 'unit'), literal(String(unit), namedNode(NS.xsd + 'string'))));
      if (isLoinc && loincCode) quads.push(makeQuad(subj, namedNode(NS.clinical + 'loincCode'), namedNode(resolveCodeUri(loincOid, loincCode))));
      if (displayName) quads.push(makeQuad(subj, namedNode(NS.health + 'vitalName'), literal(displayName)));
      if (dateStr) quads.push(makeQuad(subj, namedNode(NS.clinical + 'effectiveDate'), literal(dateStr)));
      if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
    }
  }

  return quads;
}

/**
 * Build a health:LabResultRecord for a vital observation whose type is not in the
 * VitalSignShape enum, preserving its value. health:LabResultRecord has no
 * SHACL target shape, so this validates cleanly while keeping the data.
 */
function buildLabFallback(args: {
  sourceSystem: string;
  loincCode: string;
  isLoinc: boolean;
  loincOid: string;
  displayName: string;
  dateStr: string;
  value: string;
  unit: string;
  sourceId: string | undefined;
  /** The raw observation. It was NOT passed before, so the last identity tier
   *  landed on the per-type sentinel rather than on a hash of the record. */
  source: unknown;
  warnings: string[] | undefined;
}): Quad[] {
  const { sourceSystem, loincCode, isLoinc, loincOid, displayName, dateStr, value, unit, sourceId, source, warnings } = args;
  const quads: Quad[] = [];

  const uri = ccdaRecordUri({
    type: 'LabResult',
    sourceId,
    content: {
      loincCode: isLoinc ? loincCode : undefined,
      testName: displayName || undefined,
      date: dateStr || undefined,
      value: value || undefined,
      unit: unit || undefined,
    },
    source,
    warnings,
    label: 'C-CDA vital-sign observation (recorded as a lab result)',
  });

  const subj = namedNode(uri);
  quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.health + 'LabResultRecord')));
  quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));
  if (isLoinc && loincCode) quads.push(makeQuad(subj, namedNode(NS.health + 'testCode'), namedNode(resolveCodeUri(loincOid, loincCode))));
  if (displayName) quads.push(makeQuad(subj, namedNode(NS.health + 'testName'), literal(displayName)));
  if (dateStr) quads.push(makeQuad(subj, namedNode(NS.health + 'performedDate'), literal(dateStr)));
  if (value) quads.push(makeQuad(subj, namedNode(NS.health + 'resultValue'), literal(String(value))));
  if (unit) quads.push(makeQuad(subj, namedNode(NS.health + 'resultUnit'), literal(String(unit))));
  if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
  return quads;
}
