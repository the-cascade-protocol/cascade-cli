/**
 * Code-system identification and the medication code-key ladder for cascade-cli.
 *
 * CANONICAL SOURCE: `sdk-typescript/src/utils/code-keys.ts`.
 *
 * Byte-identical port (the same arrangement used for `deterministicUuid` and the
 * medication normalizer). The CLI takes no runtime dependency on
 * `@the-cascade-protocol/sdk`; this copy is held to the canonical definition by
 * a parity test (`tests/code-keys.test.ts`, vectors matching the SDK's). Change
 * the behaviour in both repos in the same pass, or the reconciler matcher and
 * the conversation grounder will classify codes differently.
 *
 * Ladder (Checkup MedicationReconciler.ReconciliationKeyType):
 *   RxNorm (100) > SNOMED (80) > NDC (60) > ATC (40) > normalized name (20)
 *
 * Determinism-first: string prefix matching only. Codes map onto ratified
 * systems (RxNorm/SNOMED/NDC/ATC/LOINC/ICD-10/CVX); no codes are invented here.
 */

/** Ratified code systems Cascade recognizes on records. */
export type CodeSystem =
  | 'rxnorm'
  | 'snomed'
  | 'ndc'
  | 'atc'
  | 'loinc'
  | 'icd10'
  | 'cvx';

const SYSTEM_ROOTS: Record<CodeSystem, readonly string[]> = {
  rxnorm: ['http://www.nlm.nih.gov/research/umls/rxnorm', 'urn:oid:2.16.840.1.113883.6.88'],
  snomed: ['http://snomed.info/sct', 'urn:oid:2.16.840.1.113883.6.96'],
  ndc: ['http://hl7.org/fhir/sid/ndc', 'urn:oid:2.16.840.1.113883.6.69'],
  atc: ['http://www.whocc.no/atc', 'urn:oid:2.16.840.1.113883.6.73'],
  loinc: ['http://loinc.org', 'urn:oid:2.16.840.1.113883.6.1'],
  icd10: ['http://hl7.org/fhir/sid/icd-10', 'urn:oid:2.16.840.1.113883.6.90', 'urn:oid:2.16.840.1.113883.6.3'],
  cvx: ['http://hl7.org/fhir/sid/cvx', 'urn:oid:2.16.840.1.113883.12.292'],
};

/** Identify the ratified code system a code URI belongs to, if recognized. */
export function classifyCodeSystem(uri: string): CodeSystem | undefined {
  for (const system of Object.keys(SYSTEM_ROOTS) as CodeSystem[]) {
    if (SYSTEM_ROOTS[system].some((root) => uri.startsWith(root))) return system;
  }
  return undefined;
}

/**
 * Extract the bare code value from a code URI: the final path segment, then the
 * final fragment. `.../rxnorm/29046` -> `29046`; `http://loinc.org/rdf#4548-4`
 * -> `4548-4`. A bare value (no `/` or `#`) is returned unchanged.
 */
export function extractCodeValue(uri: string): string {
  const lastPath = uri.includes('/') ? uri.slice(uri.lastIndexOf('/') + 1) : uri;
  return lastPath.includes('#') ? lastPath.slice(lastPath.lastIndexOf('#') + 1) : lastPath;
}

/** A recognized code on a record. */
export interface CodeRef {
  system: CodeSystem;
  value: string;
}

/**
 * All recognized, de-duplicated code refs from a set of code URIs, regardless of
 * system. The general index key extractor; unrecognized URIs are skipped.
 */
export function codeRefsFromUris(uris: Iterable<string>): CodeRef[] {
  const out: CodeRef[] = [];
  const seen = new Set<string>();
  for (const uri of uris) {
    const system = classifyCodeSystem(uri);
    if (!system) continue;
    const value = extractCodeValue(uri);
    const k = `${system}:${value}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ system, value });
    }
  }
  return out;
}

// ─── Medication identity ladder ────────────────────────────────────────────--

/** Drug-code systems and their identity strength (Checkup ReconciliationKeyType). */
export const MEDICATION_CODE_TIER: Record<'rxnorm' | 'snomed' | 'ndc' | 'atc', number> = {
  rxnorm: 100,
  snomed: 80,
  ndc: 60,
  atc: 40,
};

/** Tier for the normalized-name fallback key (weakest identity). */
export const MEDICATION_NAME_TIER = 20;

/** A medication identity key: a coded key, or the normalized-name fallback. */
export interface CodeKey {
  system: CodeSystem | 'name';
  value: string;
  tier: number;
}

function isDrugSystem(system: CodeSystem): system is 'rxnorm' | 'snomed' | 'ndc' | 'atc' {
  return system in MEDICATION_CODE_TIER;
}

/**
 * The medication identity keys a record carries, strongest first, with an
 * optional normalized-name fallback appended last. Only drug-code systems
 * contribute coded keys; LOINC/ICD-10/CVX are ignored.
 */
export function medicationCodeKeys(codeUris: Iterable<string>, normalizedName?: string): CodeKey[] {
  const keys: CodeKey[] = [];
  for (const { system, value } of codeRefsFromUris(codeUris)) {
    if (isDrugSystem(system)) {
      keys.push({ system, value, tier: MEDICATION_CODE_TIER[system] });
    }
  }
  keys.sort((a, b) => b.tier - a.tier);
  if (normalizedName && normalizedName.length > 0) {
    keys.push({ system: 'name', value: normalizedName, tier: MEDICATION_NAME_TIER });
  }
  return keys;
}

/** The single strongest medication identity key, or undefined if none. */
export function strongestMedicationCodeKey(
  codeUris: Iterable<string>,
  normalizedName?: string,
): CodeKey | undefined {
  return medicationCodeKeys(codeUris, normalizedName)[0];
}

/**
 * The strongest identity key shared by two medications, walking the ladder
 * (RxNorm > SNOMED > NDC > ATC, then a normalized-name match), or undefined when
 * they share none. `a` should be tier-sorted (as medicationCodeKeys returns it).
 */
export function sharedMedicationCodeKey(a: CodeKey[], b: CodeKey[]): CodeKey | undefined {
  const bKeys = new Set(b.map((k) => `${k.system}:${k.value}`));
  for (const k of a) {
    if (bKeys.has(`${k.system}:${k.value}`)) return k;
  }
  return undefined;
}
