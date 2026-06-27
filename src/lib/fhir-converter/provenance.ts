/**
 * Per-resource provenance capture: the performing/ordering clinician and the
 * source EHR / organization.
 *
 * Apple Health (and most FHIR) carry these inline on `performer` / `requester` /
 * `recorder` / `asserter` and in the endpoint host of provider reference URLs,
 * but the per-type converters historically read them for only three types
 * (DiagnosticReport, Encounter, Immunization). Everything else dropped the
 * provider that the source actually provided, which violates the "Cascade does
 * not drop data" tenet and is why an Apple Health pod ends up with no usable
 * source axis. This shared pass recovers both signals uniformly:
 *
 *   - clinical:providerName  the clinician/performer display. Reuses the
 *     predicate the converters already emit on LaboratoryReport/Encounter rather
 *     than minting new vocabulary (which would need a spec cycle).
 *   - clinical:sourceEHR     the source system / organization: an org-looking
 *     provider display when present (e.g. "Kaiser Permanente Washington"), else
 *     the registrable host of a provider reference endpoint
 *     (e.g. https://haiku.swedish.org/... -> "swedish.org"). This is the axis the
 *     source-organized Records view needs. `sourceEHR` is intentionally broad in
 *     the ontology ("LabResult and other EHR-sourced records").
 *
 * Additive + idempotent: it never overwrites a value a converter already set,
 * and it emits nothing when the resource carries no provenance signal (so a
 * record with only a relative-reference provider keeps an honest, empty source
 * rather than a fabricated one). Shapes are not `sh:closed`, so the extra
 * predicates validate cleanly on every record type.
 */

import type { Quad } from 'n3';

import { NS, tripleStr } from './types.js';

/** Resource fields, in priority order, that name the performing/ordering agent. */
const PROVIDER_FIELDS = [
  'performer',
  'requester',
  'recorder',
  'asserter',
  'serviceProvider',
] as const;

/** FHIR resource types that represent a clinical record with a performing agent. */
const CLINICAL_RECORD_TYPES = new Set([
  'MedicationStatement',
  'MedicationRequest',
  'Condition',
  'AllergyIntolerance',
  'Observation',
  'Procedure',
  'DocumentReference',
  'Encounter',
  'DiagnosticReport',
  'MedicationAdministration',
  'Device',
  'ImagingStudy',
  'Immunization',
]);

/**
 * Institution-level words for the org-display FALLBACK (used only when no
 * reference host is available). Deliberately multi-word / proper-noun terms, not
 * role words like "medical" or "radiology" that also appear in a clinician's
 * title ("Medical Assistant", "Radiologist").
 */
const INSTITUTION_KEYWORDS =
  /\b(permanente|hospital|health system|healthcare|health services|health center|medical center|medical centre|medical group|clinic|laboratory|laboratories|imaging center|pathology associates|kaiser|sutter|providence|swedish|cerner|mayo)\b/i;

/** Clinician role / credential markers: if a display has one, it is a PERSON. */
const PERSON_ROLE =
  /(\b(MD|DO|RN|NP|PA|PA-C|CMA|CNA|MA|CM|PhD|DDS|DMD|Dr|Nurse|Technician|Tech|Phlebotomist|Radiologist)\b|Medical Assistant|, [A-Z]{1,4}$)/;

/** The first `.display` among a node, its `.actor`, or its `.individual` (array-tolerant). */
function displayOf(node: unknown): string | undefined {
  if (!node) return undefined;
  const arr = Array.isArray(node) ? node : [node];
  for (const n of arr) {
    const r = n as { display?: unknown; actor?: { display?: unknown }; individual?: { display?: unknown } };
    const d = r?.display ?? r?.actor?.display ?? r?.individual?.display;
    if (typeof d === 'string' && d.trim()) return d.trim();
  }
  return undefined;
}

/** The clinician/performer display from the first populated provider field. */
export function extractProviderName(resource: any): string | undefined {
  for (const field of PROVIDER_FIELDS) {
    const d = displayOf(resource?.[field]);
    if (d) return d;
  }
  return undefined;
}

/** The registrable domain of a host ("haiku.swedish.org" -> "swedish.org"). */
function registrableDomain(host: string): string {
  const labels = host.split('.').filter(Boolean);
  // Last two labels is the registrable domain for the common (US health) case.
  return labels.length > 2 ? labels.slice(-2).join('.') : host;
}

/**
 * The host of the FIRST absolute (http/https) `reference` anywhere in the
 * resource. Every reference in an Apple Health record points at the SAME source
 * FHIR server (e.g. haiku.swedish.org), so any one identifies the source system,
 * including on records (lab Observations) whose own performer is absent and whose
 * only absolute reference is the subject/encounter.
 */
function sourceHost(resource: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object' || seen.has(node)) return undefined;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const h = walk(item);
        if (h) return h;
      }
      return undefined;
    }
    const obj = node as Record<string, unknown>;
    const ref = obj.reference;
    if (typeof ref === 'string' && /^https?:\/\//i.test(ref)) {
      try {
        return registrableDomain(new URL(ref).hostname);
      } catch {
        /* not parseable: keep walking */
      }
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') {
        const h = walk(v);
        if (h) return h;
      }
    }
    return undefined;
  };
  return walk(resource);
}

/**
 * The source EHR/organization. Prefer the source FHIR server host (unambiguous,
 * clean, low-cardinality, present even when the performer is not); fall back to
 * an institution-looking provider display only when no host is available, never
 * a clinician's name.
 */
export function extractSourceEhr(resource: any): string | undefined {
  const host = sourceHost(resource);
  if (host) return host;
  const display = extractProviderName(resource);
  if (display && INSTITUTION_KEYWORDS.test(display) && !PERSON_ROLE.test(display)) {
    return display;
  }
  return undefined;
}

/**
 * Append clinical:providerName + clinical:sourceEHR to a converted resource's
 * record subjects (those carrying an rdf:type), without overwriting any value a
 * converter already set. No-op when the resource is not a clinical record or
 * carries no provenance signal.
 */
export function appendProvenanceQuads(resource: any, quads: Quad[]): void {
  if (!resource || !CLINICAL_RECORD_TYPES.has(resource.resourceType)) return;

  const provider = extractProviderName(resource);
  const sourceEhr = extractSourceEhr(resource);
  if (!provider && !sourceEhr) return;

  const subjects = new Set<string>();
  const hasProvider = new Set<string>();
  const hasSourceEhr = new Set<string>();
  for (const q of quads) {
    const p = q.predicate.value;
    if (p === NS.rdf + 'type') subjects.add(q.subject.value);
    // A converter may already carry the provider under either predicate.
    else if (p === NS.clinical + 'providerName' || p === NS.health + 'administeringProvider') {
      hasProvider.add(q.subject.value);
    } else if (p === NS.clinical + 'sourceEHR') {
      hasSourceEhr.add(q.subject.value);
    }
  }

  for (const subject of subjects) {
    if (provider && !hasProvider.has(subject)) {
      quads.push(tripleStr(subject, NS.clinical + 'providerName', provider));
    }
    if (sourceEhr && !hasSourceEhr.has(subject)) {
      quads.push(tripleStr(subject, NS.clinical + 'sourceEHR', sourceEhr));
    }
  }
}
