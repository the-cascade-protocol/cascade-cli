/**
 * Phenopacket medicalActions[] → checkup:recommendedActions text.
 *
 * Phenopacket medicalActions are a heterogeneous bag — each entry carries
 * exactly one of:
 *
 *   - `procedure`         { code, bodySite, performed }
 *   - `treatment`         { agent, routeOfAdministration, doseIntervals[],
 *                           cumulativeDose, drugType }
 *   - `radiationTherapy`  { modality, bodySite, dosage, fractions }
 *   - `therapeuticRegimen`{ ontologyClass, externalReference, regimenStatus,
 *                           startTime, endTime }
 *
 * v1-draft has NO structured medical-action vocabulary. Per the
 * implementation plan, we serialize each action as a free-text
 * `checkup:recommendedActions` triple on the patient profile, and emit
 * an info-severity gap per structured field that's lost in the
 * stringification. This keeps the data discoverable while making the
 * schema-evolution opportunity visible.
 *
 * The checkup namespace lives at https://ns.cascadeprotocol.org/checkup/v1#
 * — distinct from cascade / clinical / health / genomics.
 */

import type { Quad } from './types.js';
import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import { tripleStr } from '../fhir-converter/types.js';

const CHECKUP_NS = 'https://ns.cascadeprotocol.org/checkup/v1#';

export interface MedicalActionsParseOutput {
  /** Triples to attach to the patient profile. */
  quads: Quad[];
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

/**
 * Format a phenopacket procedure into a single-line summary.
 */
function summarizeProcedure(p: any): string {
  const code = p?.code;
  const bodySite = p?.bodySite;
  const performed = p?.performed?.timestamp ?? p?.performed?.age?.iso8601duration;
  const parts: string[] = [];
  parts.push(`Procedure: ${code?.label ?? code?.id ?? '<unspecified>'}`);
  if (bodySite) parts.push(`@ ${bodySite.label ?? bodySite.id}`);
  if (performed) parts.push(`(performed ${performed})`);
  return parts.join(' ');
}

/**
 * Format a phenopacket treatment into a single-line summary.
 */
function summarizeTreatment(t: any): string {
  const agent = t?.agent;
  const route = t?.routeOfAdministration;
  const doses = Array.isArray(t?.doseIntervals) ? t.doseIntervals : [];
  const parts: string[] = [];
  parts.push(`Treatment: ${agent?.label ?? agent?.id ?? '<unspecified agent>'}`);
  if (route) parts.push(`via ${route.label ?? route.id}`);
  if (doses.length > 0) {
    const d = doses[0];
    const value = d?.quantity?.value;
    const unit = d?.quantity?.unit?.label ?? d?.quantity?.unit?.id;
    if (value !== undefined && unit) parts.push(`${value} ${unit}`);
    if (d?.scheduleFrequency?.label) parts.push(`x${d.scheduleFrequency.label}`);
    if (doses.length > 1) parts.push(`(${doses.length} dose intervals)`);
  }
  if (t?.treatmentTerminationReason) {
    parts.push(`(terminated: ${t.treatmentTerminationReason.label ?? t.treatmentTerminationReason.id})`);
  }
  return parts.join(' ');
}

/**
 * Format a radiation therapy entry.
 */
function summarizeRadiation(r: any): string {
  const modality = r?.modality;
  const bodySite = r?.bodySite;
  const fractions = r?.fractions;
  const dose = r?.dosage;
  const parts: string[] = [];
  parts.push(`Radiotherapy: ${modality?.label ?? modality?.id ?? '<unspecified>'}`);
  if (bodySite) parts.push(`@ ${bodySite.label ?? bodySite.id}`);
  if (dose !== undefined) parts.push(`dose=${dose}`);
  if (fractions !== undefined) parts.push(`fractions=${fractions}`);
  return parts.join(' ');
}

/**
 * Format a therapeutic regimen entry.
 */
function summarizeRegimen(r: any): string {
  const cls = r?.ontologyClass ?? r?.externalReference;
  const status = r?.regimenStatus;
  const start = r?.startTime?.timestamp ?? r?.startTime?.age?.iso8601duration;
  const end = r?.endTime?.timestamp ?? r?.endTime?.age?.iso8601duration;
  const parts: string[] = [];
  parts.push(`Regimen: ${cls?.label ?? cls?.id ?? '<unspecified>'}`);
  if (status) parts.push(`(${status})`);
  if (start) parts.push(`start=${start}`);
  if (end) parts.push(`end=${end}`);
  return parts.join(' ');
}

function summarizeAction(action: any): { kind: string; text: string } {
  if (action?.procedure) return { kind: 'procedure', text: summarizeProcedure(action.procedure) };
  if (action?.treatment) return { kind: 'treatment', text: summarizeTreatment(action.treatment) };
  if (action?.radiationTherapy) {
    return { kind: 'radiationTherapy', text: summarizeRadiation(action.radiationTherapy) };
  }
  if (action?.therapeuticRegimen) {
    return { kind: 'therapeuticRegimen', text: summarizeRegimen(action.therapeuticRegimen) };
  }
  return { kind: 'unknown', text: 'Unrecognized medical action' };
}

/**
 * Parse phenopacket.medicalActions[] and produce free-text triples on the
 * patient profile.
 */
export function parseMedicalActions(
  actions: any[] | undefined,
  patientIri: string,
  ctx: ImportContext,
  contextLabel: string,
): MedicalActionsParseOutput {
  void ctx;
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  if (!Array.isArray(actions) || actions.length === 0) {
    return { quads, warnings, gaps };
  }

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i] ?? {};
    const { kind, text } = summarizeAction(action);

    // Attach to the patient profile as free text.
    quads.push(tripleStr(patientIri, CHECKUP_NS + 'recommendedActions', text));

    // Emit info gap for the structured detail we serialized away.
    gaps.push({
      sourceField: `${contextLabel}.medicalActions[${i}]`,
      reason: `Medical action of kind "${kind}" stringified into checkup:recommendedActions — v1-draft has no structured medical-action vocabulary (procedure / treatment / radiation / regimen). Treatment dosing, agents, intent, target, and adverse events all flatten into free text.`,
      severity: 'info',
      context: undefined,
    });

    // Per-kind extra info gaps for the load-bearing fields.
    if (kind === 'treatment' && action.treatment) {
      const t = action.treatment;
      if (Array.isArray(t.doseIntervals) && t.doseIntervals.length > 0) {
        gaps.push({
          sourceField: `${contextLabel}.medicalActions[${i}].treatment.doseIntervals`,
          reason: `${t.doseIntervals.length} dose-interval entries flattened to text — no v1-draft slot for structured dosing.`,
          severity: 'info',
          context: undefined,
        });
      }
      if (t.cumulativeDose) {
        gaps.push({
          sourceField: `${contextLabel}.medicalActions[${i}].treatment.cumulativeDose`,
          reason: 'Cumulative dose dropped — no v1-draft slot.',
          severity: 'info',
          context: undefined,
        });
      }
      if (Array.isArray(action.adverseEvents) && action.adverseEvents.length > 0) {
        gaps.push({
          sourceField: `${contextLabel}.medicalActions[${i}].adverseEvents`,
          reason: `${action.adverseEvents.length} adverse-event term(s) dropped — no v1-draft slot.`,
          severity: 'info',
          context: undefined,
        });
      }
    }
    if (action.treatmentTarget) {
      gaps.push({
        sourceField: `${contextLabel}.medicalActions[${i}].treatmentTarget`,
        reason: `treatmentTarget (${action.treatmentTarget.label ?? action.treatmentTarget.id}) dropped — no v1-draft slot.`,
        severity: 'info',
        context: undefined,
      });
    }
    if (action.treatmentIntent) {
      gaps.push({
        sourceField: `${contextLabel}.medicalActions[${i}].treatmentIntent`,
        reason: `treatmentIntent (${action.treatmentIntent.label ?? action.treatmentIntent.id}) dropped — no v1-draft slot.`,
        severity: 'info',
        context: undefined,
      });
    }
    if (action.treatmentResponse) {
      gaps.push({
        sourceField: `${contextLabel}.medicalActions[${i}].treatmentResponse`,
        reason: `treatmentResponse dropped — no v1-draft slot.`,
        severity: 'info',
        context: undefined,
      });
    }
  }

  return { quads, warnings, gaps };
}
