/**
 * Who does an incoming health record name, and is it the pod's owner?
 *
 * Two consumers share this module:
 *
 *  - `pod import` computes {@link PatientMatch} for its report: a verdict on
 *    whether the files being imported name the same person the pod belongs to.
 *    It never changes the exit code and never blocks; it is a warning a caller
 *    can act on (warn, then let the person confirm).
 *  - `cascade inspect patient` prints the incoming name and birth date itself,
 *    so an application holding several pods (a family) can say WHICH member a
 *    file looks like it belongs to.
 *
 * THE PHI RULE
 * ------------
 * {@link PatientMatch} carries booleans, an enum and field NAMES only, never a
 * name or a date. Import reports are written to `--report` files and land in
 * application logs, so a verdict that quoted the mismatching name would leak
 * the very thing it is about.
 *
 * {@link IncomingPatient} DOES carry the values. It exists only for the
 * `inspect patient` stdout payload, which is for an in-process caller and must
 * never be written to a report, a log line or a warning. Nothing in `pod
 * import` serializes it.
 *
 * READING
 * -------
 * C-CDA is read through `readCcdaPatientIdentity`, the same reader the
 * converter uses, so the two cannot disagree about who a document names. An
 * IHE XDM zip is read document by document. FHIR is read from every `Patient`
 * resource, at the top level, in a Bundle (nested Bundles included) or in an
 * array or NDJSON stream. Cascade Turtle is read from its
 * `cascade:PatientProfile` subjects. A file that names nobody (an Apple Health
 * clinical record, which carries no Patient resource) yields no patients.
 */

import AdmZip from 'adm-zip';
import { Parser } from 'n3';
import { parseCcdaXml } from './ccda-converter/parser.js';
import { detectVendor } from './ccda-converter/vendor/detect.js';
import { applyVendorNormalization } from './ccda-converter/vendor/normalize.js';
import { readCcdaPatientIdentity } from './ccda-converter/sections/patient.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { looksLikeZip, type ImportInputKind } from './import-input.js';
import { readResource } from './pod-encryption.js';

// ─── What an incoming file names ─────────────────────────────────────────────

/**
 * The patient one incoming document names. PHI: see the module note. Each
 * field is absent when the document does not state it.
 */
export interface IncomingPatient {
  /** Display name: given name(s) then family name, single-spaced. */
  name?: string;
  /** Birth date as `YYYY-MM-DD`, or the shorter `YYYY` / `YYYY-MM` the source stated. */
  birthDate?: string;
}

const NS_RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const NS_CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';
const NS_FOAF = 'http://xmlns.com/foaf/0.1/';

function textOf(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#text' in (v as Record<string, unknown>)) {
    return textOf((v as Record<string, unknown>)['#text']);
  }
  return '';
}

function joinName(parts: string[]): string | undefined {
  const s = parts.map((p) => p.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
  return s || undefined;
}

/** `YYYYMMDD...` (C-CDA TS) or `YYYY-MM-DD...` to the date part, hyphenated. */
export function normalizeBirthDate(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const hyphenated = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(s);
  if (hyphenated && (s.length === 4 || s[4] === '-')) {
    return [hyphenated[1], hyphenated[2], hyphenated[3]].filter(Boolean).join('-');
  }
  const compact = /^(\d{4})(\d{2})?(\d{2})?/.exec(s);
  if (compact) return [compact[1], compact[2], compact[3]].filter(Boolean).join('-');
  return undefined;
}

function patientOf(name: string | undefined, birthDate: string | undefined): IncomingPatient | undefined {
  const p: IncomingPatient = {};
  if (name) p.name = name;
  if (birthDate) p.birthDate = birthDate;
  return p.name || p.birthDate ? p : undefined;
}

/** The C-CDA documents in a single XML or an IHE XDM zip. */
function ccdaDocuments(bytes: Buffer): string[] {
  if (!looksLikeZip(bytes)) return [bytes.toString('utf-8')];
  const docs: string[] = [];
  const zip = new AdmZip(bytes);
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory && entry.entryName.toLowerCase().endsWith('.xml')) {
      docs.push(entry.getData().toString('utf-8'));
    }
  }
  return docs;
}

interface Read {
  patients: IncomingPatient[];
  /** False when the bytes could not be read as their kind at all. */
  readable: boolean;
}

function ccdaPatients(bytes: Buffer): Read {
  const out: IncomingPatient[] = [];
  let documents = 0;
  for (const xml of ccdaDocuments(bytes)) {
    let doc: any;
    try {
      const parsed = parseCcdaXml(xml);
      doc = applyVendorNormalization(parsed, detectVendor(parsed));
    } catch {
      continue; // not well-formed XML
    }
    if (!doc?.ClinicalDocument) continue; // not a C-CDA document (an XDM METADATA.XML, say)
    documents++;
    const recordTarget = doc.ClinicalDocument.recordTarget;
    if (!recordTarget) continue;
    const id = readCcdaPatientIdentity(recordTarget);
    const p = patientOf(
      joinName([textOf(id.given), textOf(id.family)]),
      normalizeBirthDate(textOf(id.birthTime)),
    );
    if (p) out.push(p);
  }
  return { patients: out, readable: documents > 0 };
}

/** The HumanName a person is known by: `official`, else `usual`, else the first. */
function fhirName(names: unknown): string | undefined {
  if (!Array.isArray(names) || names.length === 0) return undefined;
  const pick =
    names.find((n) => n?.use === 'official') ??
    names.find((n) => n?.use === 'usual') ??
    names[0];
  if (!pick || typeof pick !== 'object') return undefined;
  const given = Array.isArray(pick.given) ? pick.given.map(textOf) : [textOf(pick.given)];
  const family = textOf(pick.family);
  return joinName([...given, family]) ?? (joinName([textOf(pick.text)]));
}

function collectFhirPatients(node: unknown, out: IncomingPatient[], depth = 0): void {
  if (depth > 8 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectFhirPatients(n, out, depth + 1);
    return;
  }
  const r = node as Record<string, any>;
  if (r.resourceType === 'Patient') {
    const p = patientOf(fhirName(r.name), normalizeBirthDate(textOf(r.birthDate)));
    if (p) out.push(p);
    return;
  }
  if (r.resourceType === 'Bundle' && Array.isArray(r.entry)) {
    for (const e of r.entry) collectFhirPatients(e?.resource, out, depth + 1);
  }
}

function fhirPatients(text: string): Read {
  const out: IncomingPatient[] = [];
  const t = text.replace(/^\uFEFF/, '');
  try {
    collectFhirPatients(JSON.parse(t), out);
    return { patients: out, readable: true };
  } catch {
    // NDJSON: one resource per line.
  }
  let lines = 0;
  for (const line of t.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      collectFhirPatients(JSON.parse(line), out);
      lines++;
    } catch {
      /* a line that is not JSON names nobody */
    }
  }
  return { patients: out, readable: lines > 0 };
}

function turtlePatients(text: string): Read {
  let quads;
  try {
    quads = new Parser({ format: 'Turtle', baseIRI: 'urn:cascade:incoming:' }).parse(text);
  } catch {
    return { patients: [], readable: false };
  }
  const profiles = new Set(
    quads
      .filter((q) => q.predicate.value === NS_RDF_TYPE && q.object.value === `${NS_CASCADE}PatientProfile`)
      .map((q) => q.subject.value),
  );
  const out: IncomingPatient[] = [];
  for (const subj of profiles) {
    const get = (iri: string) => quads.find((q) => q.subject.value === subj && q.predicate.value === iri)?.object.value ?? '';
    const name =
      joinName([get(`${NS_CASCADE}givenName`), get(`${NS_CASCADE}familyName`)]) ?? joinName([get(`${NS_FOAF}name`)]);
    const p = patientOf(name, normalizeBirthDate(get(`${NS_CASCADE}dateOfBirth`)));
    if (p) out.push(p);
  }
  return { patients: out, readable: true };
}

/**
 * Every patient one input file names, in document order, duplicates removed.
 * Empty when the file names nobody or cannot be read as its kind. Never throws.
 */
export function readIncomingPatients(bytes: Buffer, kind: ImportInputKind): IncomingPatient[] {
  return readIncoming(bytes, kind).patients;
}

/**
 * {@link readIncomingPatients}, plus whether the file could be read as its
 * kind at all. "Names nobody" and "could not be read" are different answers,
 * and `inspect patient` reports them differently. Never throws.
 */
export function readIncoming(bytes: Buffer, kind: ImportInputKind): Read {
  let found: Read;
  try {
    if (kind === 'ccda') found = ccdaPatients(bytes);
    else if (kind === 'fhir-json') found = fhirPatients(bytes.toString('utf-8'));
    else found = turtlePatients(bytes.toString('utf-8'));
  } catch {
    return { patients: [], readable: false };
  }
  return { patients: distinctPatients(found.patients), readable: found.readable };
}

/** Distinct by (normalized name, birth date), keeping first occurrence. */
export function distinctPatients(patients: IncomingPatient[]): IncomingPatient[] {
  const seen = new Set<string>();
  const out: IncomingPatient[] = [];
  for (const p of patients) {
    const key = `${nameTokens(p.name).join(' ')}\u0000${p.birthDate ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// ─── Comparing ────────────────────────────────────────────────────────────────

/**
 * Lowercased, accent-stripped word tokens of a name. Punctuation (hyphens,
 * apostrophes, periods) separates words, so "Smith-Jones" and "Smith Jones"
 * tokenize alike.
 */
export function nameTokens(name: string | undefined): string[] {
  if (!name) return [];
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Normalized name comparison. Two names with at least two words each match
 * when their first words and last words agree, so a middle name present on one
 * side only does not count against a match ("Maya Rose Lee" and "Maya Lee").
 * A one-word name matches a name whose first word it equals.
 *
 * Deliberately not fuzzy: a nickname ("Johnny" for "John") is a mismatch, and
 * the verdict that follows is a warning a person confirms, never a block.
 */
export function namesMatch(a: string | undefined, b: string | undefined): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  if (ta[0] !== tb[0]) return false;
  if (ta.length >= 2 && tb.length >= 2) return ta[ta.length - 1] === tb[tb.length - 1];
  return true;
}

/**
 * Exact date of birth, compared at the precision both sides state: a source
 * that gives only a year agrees with a full date in that year.
 */
export function birthDatesMatch(a: string | undefined, b: string | undefined): boolean {
  const na = a ? normalizeBirthDate(a) : undefined;
  const nb = b ? normalizeBirthDate(b) : undefined;
  if (!na || !nb) return false;
  return na.length <= nb.length ? nb.startsWith(na) : na.startsWith(nb);
}

/** Field names {@link PatientMatch.comparedFields} can list. */
export type PatientMatchField = 'name' | 'dateOfBirth';

/**
 * Does the import name the pod's owner? PHI-free by construction: booleans,
 * an enum, field names and a fixed-vocabulary `detail`.
 *
 *  - `match`: every field both sides state agrees, for every patient the
 *    incoming files name.
 *  - `mismatch`: some field both sides state disagrees, for at least one
 *    incoming patient. `detail` names the fields.
 *  - `unverified`: nothing is comparable. The ordinary first import into a
 *    fresh pod, and any import whose files name nobody.
 */
export interface PatientMatch {
  status: 'match' | 'mismatch' | 'unverified';
  comparedFields: PatientMatchField[];
  pod: { hasName: boolean; hasDob: boolean };
  incoming: { hasName: boolean; hasDob: boolean };
  detail?: string;
}

/** What the pod already says about its owner. PHI: never serialized. */
export interface PodOwnerIdentity {
  name?: string;
  dateOfBirth?: string;
}

export function computePatientMatch(pod: PodOwnerIdentity, incoming: IncomingPatient[]): PatientMatch {
  const people = distinctPatients(incoming);
  const podSide = { hasName: nameTokens(pod.name).length > 0, hasDob: !!(pod.dateOfBirth && normalizeBirthDate(pod.dateOfBirth)) };
  const inSide = {
    hasName: people.some((p) => nameTokens(p.name).length > 0),
    hasDob: people.some((p) => !!p.birthDate),
  };

  const compared = new Set<PatientMatchField>();
  const differing = new Set<PatientMatchField>();
  let peopleDiffering = 0;
  for (const p of people) {
    let differs = false;
    if (podSide.hasName && nameTokens(p.name).length > 0) {
      compared.add('name');
      if (!namesMatch(pod.name, p.name)) { differing.add('name'); differs = true; }
    }
    if (podSide.hasDob && p.birthDate) {
      compared.add('dateOfBirth');
      if (!birthDatesMatch(pod.dateOfBirth, p.birthDate)) { differing.add('dateOfBirth'); differs = true; }
    }
    if (differs) peopleDiffering++;
  }

  const comparedFields = (['name', 'dateOfBirth'] as const).filter((f) => compared.has(f));
  const base = { comparedFields, pod: podSide, incoming: inSide };

  if (comparedFields.length === 0) {
    const why = !podSide.hasName && !podSide.hasDob
      ? 'the pod states no owner name or date of birth'
      : people.length === 0
        ? 'the incoming files name no patient'
        : 'the pod and the incoming files state no field in common';
    return { status: 'unverified', ...base, detail: `Nothing to compare: ${why}.` };
  }
  if (differing.size > 0) {
    const fields = (['name', 'dateOfBirth'] as const).filter((f) => differing.has(f)).join(', ');
    const who = people.length > 1
      ? ` for ${peopleDiffering} of ${people.length} patients the incoming files name`
      : '';
    return { status: 'mismatch', ...base, detail: `Differs from the pod owner: ${fields}${who}.` };
  }
  return { status: 'match', ...base };
}

/** First object value of `predicate` on any subject of `rdf:type` `type` (or any subject when `type` is omitted). */
function readValue(text: string, predicate: string, type?: string): string | undefined {
  let quads;
  try {
    quads = new Parser({ format: 'Turtle', baseIRI: 'urn:cascade:pod:' }).parse(text);
  } catch {
    return undefined;
  }
  const typed = type
    ? new Set(quads.filter((q) => q.predicate.value === NS_RDF_TYPE && q.object.value === type).map((q) => q.subject.value))
    : undefined;
  return quads.find((q) => q.predicate.value === predicate && (!typed || typed.has(q.subject.value)))?.object.value;
}

/**
 * What the pod already says about its owner, read BEFORE an import writes.
 *
 * Name: `profile/card.ttl` `foaf:name` (what `pod init --owner-name` and
 * `pod profile set-name` record), else the first `cascade:PatientProfile`'s
 * given and family name in `clinical/patient-profile.ttl`. Date of birth: that
 * profile's `cascade:dateOfBirth`, else `profile/extended.ttl`'s. First found
 * wins, as `PodReader.readPatientProfile` reads the owner.
 *
 * Best effort: a resource that is missing or will not read or parse is
 * treated as stating nothing. The verdict this feeds never fails an import.
 */
export function readPodOwnerIdentity(podDir: string, dek?: Buffer): PodOwnerIdentity {
  const read = (rel: string): string | undefined => {
    const abs = path.join(podDir, rel);
    try {
      if (!fs.existsSync(abs)) return undefined;
      return readResource(podDir, abs, dek);
    } catch {
      return undefined;
    }
  };
  const PROFILE = `${NS_CASCADE}PatientProfile`;
  const card = read(path.join('profile', 'card.ttl'));
  const clinical = read(path.join('clinical', 'patient-profile.ttl'));
  const extended = read(path.join('profile', 'extended.ttl'));

  let name = card ? readValue(card, `${NS_FOAF}name`) : undefined;
  if (!name && clinical) {
    name = joinName([
      readValue(clinical, `${NS_CASCADE}givenName`, PROFILE) ?? '',
      readValue(clinical, `${NS_CASCADE}familyName`, PROFILE) ?? '',
    ]);
  }
  const dateOfBirth =
    (clinical ? readValue(clinical, `${NS_CASCADE}dateOfBirth`, PROFILE) : undefined) ??
    (extended ? readValue(extended, `${NS_CASCADE}dateOfBirth`) : undefined);

  const owner: PodOwnerIdentity = {};
  if (name) owner.name = name;
  if (dateOfBirth) owner.dateOfBirth = dateOfBirth;
  return owner;
}
