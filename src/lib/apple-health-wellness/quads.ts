/**
 * Wellness records as triples.
 *
 * Every predicate and class written here is declared in the vocabularies this
 * CLI ships (`src/shapes/*.ttl`, health v2.11 and core v3.10), and
 * `tests/emitted-terms-declared.test.ts` holds it to that. No blank nodes: a
 * pod bucket carries none (see `bucket-write.ts`), so the value of a vital
 * reading is the flat `health:value` + `health:unit` pair the
 * `health:DailyVitalReadingShape` constrains, and the provenance activity is a
 * named node.
 */

import { DataFactory, type Quad } from 'n3';
import type {
  ActivitySummaryRecord,
  DeviceRecord,
  RuleActivity,
  SampleFile,
  StepSnapshotRecord,
  VitalReadingRecord,
  WellnessRecord,
  WorkoutRecord,
} from './aggregate.js';

const { namedNode, literal, quad } = DataFactory;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';
const HEALTH = 'https://ns.cascadeprotocol.org/health/v1#';
const FHIR = 'http://hl7.org/fhir/';
const PROV = 'http://www.w3.org/ns/prov#';
const DCT = 'http://purl.org/dc/terms/';
const SCT = 'http://snomed.info/sct/';
const LOINC = 'http://loinc.org/rdf#';

/** The value `cascade:sourceType` takes on everything read from a HealthKit export. */
const SOURCE_TYPE = 'healthKit';

class QuadBuilder {
  readonly quads: Quad[] = [];
  constructor(private readonly subject: string) {}

  type(classIri: string): this {
    this.quads.push(quad(namedNode(this.subject), namedNode(RDF_TYPE), namedNode(classIri)));
    return this;
  }
  iri(pred: string, obj: string | undefined): this {
    if (obj !== undefined) this.quads.push(quad(namedNode(this.subject), namedNode(pred), namedNode(obj)));
    return this;
  }
  str(pred: string, value: string | undefined): this {
    if (value !== undefined && value !== '') this.quads.push(quad(namedNode(this.subject), namedNode(pred), literal(value)));
    return this;
  }
  typed(pred: string, value: string | number | boolean | undefined, datatype: string): this {
    if (value === undefined) return this;
    this.quads.push(quad(namedNode(this.subject), namedNode(pred), literal(String(value), namedNode(XSD + datatype))));
    return this;
  }
}

/** A decimal's lexical form: never exponent notation, which xsd:decimal forbids. */
function decimal(v: number): string {
  if (Number.isInteger(v)) return String(v);
  const s = String(v);
  return /e/i.test(s) ? v.toFixed(10).replace(/0+$/, '').replace(/\.$/, '') : s;
}

function aggregateCommon(b: QuadBuilder, r: VitalReadingRecord | StepSnapshotRecord): void {
  b.typed(CASCADE + 'date', r.periodStart, 'dateTime')
    .typed(HEALTH + 'periodStart', r.periodStart, 'dateTime')
    .typed(HEALTH + 'periodEnd', r.periodEnd, 'dateTime')
    .str(HEALTH + 'timeZone', r.timeZone)
    .str(CASCADE + 'statistic', r.statistic)
    .typed(CASCADE + 'sampleCount', r.sampleCount, 'integer')
    .str(HEALTH + 'sourceIdSpace', 'healthkit')
    .str(CASCADE + 'sourceDeviceName', r.sourceName)
    .iri(HEALTH + 'device', r.deviceIri)
    .str(CASCADE + 'sourceType', SOURCE_TYPE)
    .iri(CASCADE + 'dataProvenance', CASCADE + 'ConsumerWellness')
    .iri(PROV + 'wasDerivedFrom', r.derivedFrom)
    .iri(PROV + 'wasGeneratedBy', r.generatedBy);
}

function vitalQuads(r: VitalReadingRecord): Quad[] {
  const b = new QuadBuilder(r.iri).type(HEALTH + 'DailyVitalReading');
  b.iri(FHIR + 'code', SCT + r.snomed)
    .iri(CASCADE + 'loincCode', LOINC + r.loinc)
    .typed(HEALTH + 'value', r.value, 'double')
    .str(HEALTH + 'unit', r.unit);
  aggregateCommon(b, r);
  return b.quads;
}

function stepQuads(r: StepSnapshotRecord): Quad[] {
  const b = new QuadBuilder(r.iri).type(HEALTH + 'DailyActivitySnapshot');
  b.typed(HEALTH + 'steps', r.steps, 'integer');
  aggregateCommon(b, r);
  return b.quads;
}

function summaryQuads(r: ActivitySummaryRecord): Quad[] {
  return new QuadBuilder(r.iri)
    .type(HEALTH + 'DailyActivitySnapshot')
    .typed(CASCADE + 'date', r.periodStart, 'dateTime')
    .typed(HEALTH + 'periodStart', r.periodStart, 'dateTime')
    .typed(HEALTH + 'periodEnd', r.periodEnd, 'dateTime')
    .str(HEALTH + 'timeZone', r.timeZone)
    .str(CASCADE + 'statistic', 'sum')
    .typed(HEALTH + 'activeEnergyKcal', r.activeEnergyKcal === undefined ? undefined : decimal(r.activeEnergyKcal), 'decimal')
    .typed(HEALTH + 'exerciseMinutes', r.exerciseMinutes, 'integer')
    .typed(HEALTH + 'standHours', r.standHours, 'integer')
    .str(HEALTH + 'sourceIdSpace', 'healthkit')
    .str(CASCADE + 'sourceDeviceName', r.sourceName)
    .str(CASCADE + 'sourceType', SOURCE_TYPE)
    .iri(CASCADE + 'dataProvenance', CASCADE + 'ConsumerWellness').quads;
}

function workoutQuads(r: WorkoutRecord): Quad[] {
  const dec = (v: number | undefined): string | undefined => (v === undefined ? undefined : decimal(v));
  return new QuadBuilder(r.iri)
    .type(HEALTH + 'Workout')
    .str(HEALTH + 'activityType', r.activityType)
    .str(HEALTH + 'sourceRecordId', r.sourceRecordId)
    .str(HEALTH + 'sourceIdSpace', 'healthkit')
    .typed(HEALTH + 'periodStart', r.periodStart, 'dateTime')
    .typed(HEALTH + 'periodEnd', r.periodEnd, 'dateTime')
    .str(HEALTH + 'timeZone', r.timeZone)
    .typed(HEALTH + 'durationMinutes', dec(r.durationMinutes), 'decimal')
    .typed(HEALTH + 'distanceMeters', dec(r.distanceMeters), 'decimal')
    .typed(HEALTH + 'activeEnergyKcal', dec(r.activeEnergyKcal), 'decimal')
    .typed(HEALTH + 'averageHeartRate', dec(r.averageHeartRate), 'decimal')
    .typed(HEALTH + 'maximumHeartRate', dec(r.maximumHeartRate), 'decimal')
    .typed(HEALTH + 'indoor', r.indoor, 'boolean')
    .str(CASCADE + 'sourceDeviceName', r.sourceName)
    .iri(HEALTH + 'device', r.deviceIri)
    .str(CASCADE + 'sourceType', SOURCE_TYPE)
    .iri(CASCADE + 'dataProvenance', CASCADE + 'DeviceGenerated').quads;
}

function deviceQuads(r: DeviceRecord): Quad[] {
  const b = new QuadBuilder(r.iri)
    .type(HEALTH + 'Device')
    .str(HEALTH + 'deviceName', r.name)
    .str(HEALTH + 'deviceModel', r.model)
    .str(HEALTH + 'hardwareVersion', r.hardware);
  for (const m of r.manufacturers) b.str(HEALTH + 'deviceManufacturer', m);
  for (const s of r.softwareVersions) b.str(HEALTH + 'softwareVersion', s);
  b.iri(CASCADE + 'dataProvenance', CASCADE + 'DeviceGenerated');
  return b.quads;
}

/** The triples of one record. */
export function recordQuads(r: WellnessRecord): Quad[] {
  switch (r.kind) {
    case 'vitalReading':
      return vitalQuads(r);
    case 'stepSnapshot':
      return stepQuads(r);
    case 'activitySummary':
      return summaryQuads(r);
    case 'workout':
      return workoutQuads(r);
    case 'device':
      return deviceQuads(r);
  }
}

/** The pod-relative path a sample file is stored at (pod-structure.md section 4.3). */
export function sampleFilePath(digest: string): string {
  return `attachments/sha-256/${digest}`;
}

/**
 * The `cascade:Attachment` node describing one retained sample pack, the
 * groups it holds (`dct:hasPart`), and each group's own node.
 *
 * Every triple here is a function of the subject's name: the pack's are fixed
 * by its bytes (it is named by their digest), and a group's by its sample
 * digest (it is named by that). A group held by two packs (the same day in two
 * exports, where some OTHER series changed) is therefore one node with the same
 * triples, listed by both packs.
 */
export function sampleFileQuads(f: SampleFile): Quad[] {
  const b = new QuadBuilder(f.iri)
    .type(CASCADE + 'Attachment')
    .str(CASCADE + 'attachmentPath', sampleFilePath(f.digest))
    .str(CASCADE + 'contentHash', f.digest)
    .str(CASCADE + 'hashAlgorithm', 'sha-256')
    .str(CASCADE + 'attachmentMediaType', 'application/json')
    .typed(CASCADE + 'byteSize', f.byteSize, 'integer')
    .str(CASCADE + 'attachmentTitle', `Apple Health samples for ${f.localDate} (${f.timeZone})`);
  for (const g of f.groups) b.iri(DCT + 'hasPart', g.iri);
  const out = b.quads;
  for (const g of f.groups) {
    const gb = new QuadBuilder(g.iri)
      .type(PROV + 'Entity')
      .str(DCT + 'identifier', g.sampleDigest)
      .str(PROV + 'label', 'Apple Health samples one set of daily aggregates was computed from; dct:identifier is the sampleDigest of their group in a pack that lists this node with dct:hasPart');
    for (const q of gb.quads) out.push(q);
  }
  return out;
}

/** The activity every computed aggregate names: the rule and its version. */
export function ruleActivityQuads(a: RuleActivity): Quad[] {
  return new QuadBuilder(a.iri)
    .type(PROV + 'Activity')
    .str(PROV + 'label', `Daily wellness aggregation of an Apple Health export (${a.rule}, rule version ${a.ruleVersion})`)
    .str(CASCADE + 'version', `${a.rule}/${a.ruleVersion}`).quads;
}
