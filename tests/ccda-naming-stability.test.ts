/**
 * Two downloads of the same C-CDA document set must name the same record the
 * same way.
 *
 * Measured on two downloads of the same document set from one EHR, seven weeks
 * apart: every record with a unique source id kept its name, but
 *
 *   - 0 of 385 section narratives kept theirs. The narrative's document context
 *     was the per-download document id (`ClinicalDocument/id`, new on every
 *     download), and its name also carried the import batch label, which by
 *     default is the downloaded file's name.
 *   - 22 of 344 records whose id is claimed by more than one statement in a
 *     document (the id-reuse disambiguator) were renamed, because the
 *     disambiguator hashed the whole element: narrative reference pointers
 *     (`text/reference/@value`, `code/originalText/reference/@value`), author
 *     organisation addresses and nested encounter wrappers, all of which move
 *     between downloads while the clinical content does not.
 *
 * The fixtures below reproduce each of those movements synthetically. Every
 * `it` outside the CONTROL blocks fails against the build before the fix, with
 * one exception said where it sits: the markup-only narrative test passes
 * there too, because that build did not digest the narrative at all; it guards
 * the exclusion list, and fails against a digest that lacks it.
 * Every identifier, name and value is invented.
 */

import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';

import { convertCcda } from '../src/lib/ccda-converter/index.js';
import { deterministicUuid } from '../src/lib/fhir-converter/types.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CLINICAL = 'https://ns.cascadeprotocol.org/clinical/v1#';
const HEALTH = 'https://ns.cascadeprotocol.org/health/v1#';
const CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';

/** What changes between two downloads of one document set. */
interface Download {
  /** `ClinicalDocument/id/@extension`: new on every download. */
  documentId: string;
  /** `ClinicalDocument/setId`, or null for a document that states none. */
  setId: string | null;
  versionNumber: string;
  /** Prefix for every narrative-internal @ID and every reference pointer. */
  idPrefix: string;
  /** Footnote text, which the EHR regenerates (a retrieval timestamp, say). */
  footnote: string;
  /** Rendering style on table cells. */
  styleCode: string;
  /** Author organisation street address. */
  street: string;
  /** Whether each lab panel restates its visit as a nested encounter wrapper. */
  nestedEncounter: boolean;
  /** The problem list's clinical text. */
  problemText: string;
  /**
   * Make the second shared-id problem and medication restate the first one's
   * clinical content with a different status: the problem Resolved, the
   * medication `completed`.
   */
  statusTwins?: boolean;
  /** Add a bare `<encounter>` citing the shared encounter id inside the lab panel. */
  citeSharedEncounter?: boolean;
  /** List a panel's results in reverse order. */
  reverseResults?: boolean;
}

const A: Download = {
  documentId: 'DOC-DOWNLOAD-A',
  setId: 'SET-HEALTH-SUMMARY',
  versionNumber: '41',
  idPrefix: 'a',
  footnote: 'Retrieved 2031-08-08 09:12',
  styleCode: 'Bold',
  street: '100 Orchard Lane',
  nestedEncounter: true,
  problemText: 'Seasonal allergic rhinitis, onset 2029',
};

/** B is a later download of the same set: same clinical content, new everything else. */
const B: Download = {
  documentId: 'DOC-DOWNLOAD-B',
  setId: 'SET-HEALTH-SUMMARY',
  versionNumber: '42',
  idPrefix: 'zq',
  footnote: 'Retrieved 2031-09-26 17:40',
  styleCode: 'Italics',
  street: '100 Orchard Ln, Suite 2',
  nestedEncounter: false,
  problemText: 'Seasonal allergic rhinitis, onset 2029',
};

const OID = '2.16.840.1.113883.19.5.777';

/** Whether `d` renders like the earlier download (the EHR's regenerated text, template versions, refills). */
const isFirst = (d: Download): boolean => d.versionNumber === A.versionNumber;

function author(d: Download): string {
  return `<author><time value="20310801"/><assignedAuthor><id root="${OID}.9" extension="AUTH-1"/>
      <representedOrganization><id root="${OID}.8"/><name>Orchard Valley Clinic</name>
        <addr><streetAddressLine>${d.street}</streetAddressLine><city>Springfield</city></addr>
      </representedOrganization></assignedAuthor></author>`;
}

/** One lab result claiming the SHARED root-only id, with a narrative pointer that moves. */
function sharedIdResult(d: Download, n: number, code: string, name: string, value: string): string {
  return `<component><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
        <id root="${OID}.1.5555"/>
        <code code="${code}" displayName="${name}" codeSystem="2.16.840.1.113883.6.1">
          <originalText><reference value="#${d.idPrefix}res${n}name"/></originalText>
        </code>
        <text><reference value="#${d.idPrefix}res${n}"/>${isFirst(d) ? `${name} ${value} mmol/L` : `${name}: ${value} mmol/L (final)`}</text>
        <statusCode code="completed"/>
        <effectiveTime value="20310801083000-0500"/>
        <value xsi:type="PQ" value="${value}" unit="mmol/L"/>
        ${author(d)}
      </observation></component>`;
}

/** A lab panel claiming the SHARED panel id, so the disambiguator decides its name. */
function panel(d: Download, code: string, results: string[]): string {
  return `<entry typeCode="DRIV"><organizer classCode="BATTERY" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.1"/>
        <id root="${OID}.5" extension="PANEL-SHARED"/>
        <code code="${code}" codeSystem="2.16.840.1.113883.6.1">
          <originalText><reference value="#${d.idPrefix}panel${code}"/></originalText>
        </code>
        <statusCode code="completed"/>
        <effectiveTime value="20310801083000-0500"/>
        ${author(d)}
        ${(d.reverseResults ? [...results].reverse() : results).join('\n')}
        ${visitWrapper(d)}
        ${d.citeSharedEncounter ? `<component><encounter classCode="ENC" moodCode="EVN"><id root="${OID}.4" extension="ENC-SHARED"/></encounter></component>` : ''}
      </organizer></entry>`;
}

function uniqueResult(d: Download): string {
  return `<component><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
        <id root="${OID}.1" extension="RES-HGB"/>
        <code code="718-7" displayName="Hemoglobin" codeSystem="2.16.840.1.113883.6.1"/>
        <text><reference value="#${d.idPrefix}hgb"/></text>
        <effectiveTime value="20310801083000-0500"/>
        <value xsi:type="PQ" value="13.9" unit="g/dL"/>
      </observation></component>`;
}

function visitWrapper(d: Download): string {
  return d.nestedEncounter
    ? `<component><encounter classCode="ENC" moodCode="EVN"><id root="${OID}.3" extension="VISIT-77"/>
        <code code="99213" codeSystem="2.16.840.1.113883.6.12"/><effectiveTime value="20310801"/></encounter></component>`
    : '';
}

/** Two encounters claiming ONE id with different clinical content: genuinely two visits. */
function sharedIdEncounter(d: Download, n: number, code: string, day: string): string {
  return `<entry typeCode="DRIV"><encounter classCode="ENC" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
      <id root="${OID}.4" extension="ENC-SHARED"/>
      <code code="${code}" codeSystem="2.16.840.1.113883.6.12">
        <originalText><reference value="#${d.idPrefix}enc${n}"/></originalText>
      </code>
      <text><reference value="#${d.idPrefix}encrow${n}"/></text>
      <effectiveTime><low value="${day}0900-0500"/><high value="${day}0945-0500"/></effectiveTime>
      ${author(d)}
      <participant typeCode="LOC"><participantRole classCode="SDLOC">
        <id root="${OID}.12" extension="LOC-${d.idPrefix}"/>
        <addr><streetAddressLine>${d.street}</streetAddressLine></addr>
        <telecom value="tel:+1-555-01${d.idPrefix.length}0"/>
        <playingEntity classCode="PLC"><name>Orchard Valley Clinic East</name></playingEntity>
      </participantRole></participant>
    </encounter></entry>`;
}

/**
 * A visit stated in full in the Encounters section, and cited elsewhere by a bare
 * `<encounter>` carrying nothing but its id, the way an EHR links a medication
 * to the visit it was ordered in.
 */
function fullVisit(d: Download): string {
  return `<entry typeCode="DRIV"><encounter classCode="ENC" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
      <id root="${OID}.3" extension="VISIT-88"/>
      <code code="99214" codeSystem="2.16.840.1.113883.6.12"/>
      <text><reference value="#${d.idPrefix}visit88"/></text>
      <effectiveTime value="20310820"/>
    </encounter></entry>`;
}

function bareVisitReference(): string {
  return `<entryRelationship typeCode="REFR"><encounter classCode="ENC" moodCode="EVN">
        <id root="${OID}.3" extension="VISIT-88"/></encounter></entryRelationship>`;
}

/** Two medications claiming ONE id with different drugs. */
function sharedIdMedication(d: Download, n: number, rx: string, name: string, status = 'active'): string {
  return `<entry typeCode="DRIV"><substanceAdministration classCode="SBADM" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.16"/>
      <id root="${OID}.6" extension="MED-SHARED"/>
      <text><reference value="#${d.idPrefix}med${n}"/></text>
      <statusCode code="${status}"/>
      <effectiveTime xsi:type="IVL_TS"><low value="20300101"/></effectiveTime>
      <consumable><manufacturedProduct classCode="MANU">
        <templateId root="2.16.840.1.113883.10.20.22.4.23" extension="${isFirst(d) ? '2014-06-09' : '2023-05-01'}"/>
        <manufacturedMaterial>
        <code code="${rx}" displayName="${name}" codeSystem="2.16.840.1.113883.6.88">
          <originalText><reference value="#${d.idPrefix}medname${n}"/></originalText>
        </code>
      </manufacturedMaterial></manufacturedProduct></consumable>
      ${author(d)}
      ${n === 1 ? bareVisitReference() : ''}
      <entryRelationship typeCode="REFR"><supply classCode="SPLY" moodCode="INT">
        <repeatNumber value="${isFirst(d) ? 5 : 3}"/><quantity value="30"/>
      </supply></entryRelationship>
    </substanceAdministration></entry>`;
}

/** Two problems claiming ONE id with different diagnoses, each with a nested status. */
function sharedIdProblem(d: Download, n: number, snomed: string, name: string, status = 'Active'): string {
  return `<entry typeCode="DRIV"><act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
      <id root="${OID}.10" extension="CONCERN-${n}"/>
      <code code="CONC" codeSystem="2.16.840.1.113883.5.6"/>
      <statusCode code="active"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
        <id root="${OID}.11" extension="PROB-SHARED"/>
        <code code="55607006" codeSystem="2.16.840.1.113883.6.96"/>
        <text><reference value="#${d.idPrefix}prob${n}"/></text>
        <effectiveTime><low value="20290401"/></effectiveTime>
        <value xsi:type="CD" code="${snomed}" displayName="${name}" codeSystem="2.16.840.1.113883.6.96"/>
        <entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
          <code code="33999-4" codeSystem="2.16.840.1.113883.6.1"/>
          <value xsi:type="CD" code="${status === 'Resolved' ? '413322009' : '55561003'}" displayName="${status}" codeSystem="2.16.840.1.113883.6.96"/>
        </observation></entryRelationship>
      </observation></entryRelationship>
    </act></entry>`;
}

/** The problem list narrative, with internal ids, a footnote and style that move. */
function problemNarrative(d: Download): string {
  const p = d.idPrefix;
  return `<text>
      <table ID="${p}tbl"><caption ID="${p}cap">Active problems</caption>
        <thead><tr ID="${p}hdr"><th>Problem</th><th>Status</th></tr></thead>
        <tbody><tr ID="${p}row1"><td ID="${p}c1" styleCode="${d.styleCode}"><content ID="${p}prob1">${d.problemText}</content></td><td>Active</td></tr></tbody>
      </table>
      <paragraph ID="${p}para">Reviewed at last visit.<footnoteRef IDREF="${p}fn1"/></paragraph>
      <footnote ID="${p}fn1">${d.footnote}</footnote>
    </text>`;
}

function download(d: Download): string {
  const setId = d.setId === null ? '' : `<setId root="${OID}.2" extension="${d.setId}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <templateId root="2.16.840.1.113883.10.20.22.1.2"/>
  <id root="${OID}.2" extension="${d.documentId}"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1"/>
  <effectiveTime value="20310926120000-0500"/>
  ${setId}
  <versionNumber value="${d.versionNumber}"/>
  <recordTarget><patientRole><id root="${OID}.7" extension="MRN-4471"/>
    <patient><name><given>Ines</given><family>Marlowe</family></name>
      <administrativeGenderCode code="F" codeSystem="2.16.840.1.113883.5.1"/><birthTime value="19800312"/></patient>
  </patientRole></recordTarget>
  <custodian><assignedCustodian><representedCustodianOrganization><id root="${OID}"/>
    <name>Orchard Valley Health</name></representedCustodianOrganization></assignedCustodian></custodian>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
      <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Problems</title>
      ${problemNarrative(d)}
      ${sharedIdProblem(d, 1, '61582004', 'Allergic rhinitis')}
      ${d.statusTwins ? sharedIdProblem(d, 2, '61582004', 'Allergic rhinitis', 'Resolved') : sharedIdProblem(d, 2, '195967001', 'Asthma')}
    </section></component>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Results</title>
      <text><paragraph ID="${d.idPrefix}r">Chemistry</paragraph></text>
      ${panel(d, '51990-0', [
        sharedIdResult(d, 1, '2951-2', 'Sodium', '139'),
        sharedIdResult(d, 2, '2823-3', 'Potassium', '4.2'),
      ])}
      ${panel(d, '57021-8', [uniqueResult(d)])}
    </section></component>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.22"/>
      <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Encounters</title>
      <text><paragraph ID="${d.idPrefix}e">Visits</paragraph></text>
      ${sharedIdEncounter(d, 1, '99213', '20310801')}
      ${sharedIdEncounter(d, 2, '99214', '20310815')}
      ${fullVisit(d)}
    </section></component>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.1.1"/>
      <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Medications</title>
      <text><paragraph ID="${d.idPrefix}m">Current medications</paragraph></text>
      ${sharedIdMedication(d, 1, '197361', 'Amlodipine 5 MG Oral Tablet')}
      ${d.statusTwins ? sharedIdMedication(d, 2, '197361', 'Amlodipine 5 MG Oral Tablet', 'completed') : sharedIdMedication(d, 2, '314076', 'Lisinopril 10 MG Oral Tablet')}
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;
}

interface Named {
  /** class local name -> sorted subject IRIs */
  byClass: Map<string, string[]>;
  /** `class|cascade:sourceRecordId` -> sorted subject IRIs */
  bySourceId: Map<string, string[]>;
  /** section LOINC -> narrative subject IRI */
  narrativeBySection: Map<string, string>;
}

async function names(xml: string, sourceSystem = 'Health Summary'): Promise<Named> {
  const result = await convertCcda(xml, { sourceSystem, importedAt: '2031-09-26T00:00:00Z' });
  expect(result.errors).toHaveLength(0);
  const quads = new Parser({ format: 'Turtle' }).parse(result.output);
  const byClass = new Map<string, string[]>();
  for (const q of quads) {
    if (q.predicate.value !== RDF_TYPE) continue;
    const cls = q.object.value.replace(CLINICAL, 'clinical:').replace(HEALTH, 'health:');
    const list = byClass.get(cls) ?? [];
    if (!list.includes(q.subject.value)) list.push(q.subject.value);
    byClass.set(cls, list);
  }
  for (const list of byClass.values()) list.sort();
  const classOf = new Map<string, string>();
  for (const [c, list] of byClass) for (const u of list) classOf.set(u, c);
  const bySourceId = new Map<string, string[]>();
  for (const q of quads) {
    if (q.predicate.value !== `${CASCADE}sourceRecordId`) continue;
    const key = `${classOf.get(q.subject.value)}|${q.object.value}`;
    const list = bySourceId.get(key) ?? [];
    if (!list.includes(q.subject.value)) list.push(q.subject.value);
    bySourceId.set(key, list.sort());
  }
  const narrativeBySection = new Map<string, string>();
  for (const q of quads) {
    if (q.predicate.value === `${CASCADE}sectionCode`) narrativeBySection.set(q.object.value, q.subject.value);
  }
  return { byClass, bySourceId, narrativeBySection };
}

const cls = (n: Named, c: string): string[] => n.byClass.get(c) ?? [];

describe('section narratives are named from the document SET, not the download', () => {
  it('two downloads of one set with the same clinical text give identical narrative names', async () => {
    const a = await names(download(A));
    const b = await names(download(B));
    expect(a.narrativeBySection.size).toBe(4);
    expect([...b.narrativeBySection]).toEqual([...a.narrativeBySection]);
  });

  it('narrative-internal ids, footnotes and styleCode alone do not rename a narrative', async () => {
    // Same document id and set, so only the markup moves. Passes before the fix
    // (no text digest then); fails if the digest loses its exclusion list.
    const a = await names(download(A));
    const b = await names(download({ ...A, idPrefix: B.idPrefix, footnote: B.footnote, styleCode: B.styleCode }));
    expect(b.narrativeBySection.get('11450-4')).toBe(a.narrativeBySection.get('11450-4'));
  });

  it('changed clinical text gives the section a new name', async () => {
    // A new name is right here: the section says something else now, and
    // folding the two versions onto one subject would leave it holding both.
    const a = await names(download(A));
    const changed = await names(download({ ...A, problemText: 'Seasonal allergic rhinitis, resolved 2031' }));
    expect(changed.narrativeBySection.get('11450-4')).not.toBe(a.narrativeBySection.get('11450-4'));
    // Only the section whose text changed moves.
    expect(changed.narrativeBySection.get('30954-2')).toBe(a.narrativeBySection.get('30954-2'));
  });

  it('the import batch label is not part of a narrative name', async () => {
    const a = await names(download(A), 'HealthSummary_2031-08-08.zip');
    const b = await names(download(A), 'HealthSummary_2031-09-26.zip');
    expect([...b.narrativeBySection]).toEqual([...a.narrativeBySection]);
  });

  it('two different document sets do not share narrative names', async () => {
    const a = await names(download(A));
    const other = await names(download({ ...A, setId: 'SET-OTHER' }));
    for (const [section, iri] of a.narrativeBySection) {
      expect(other.narrativeBySection.get(section)).not.toBe(iri);
    }
  });
});

describe('CONTROL: a document with no setId falls back to its own id', () => {
  it('a set id and a document id with the same value are different contexts', async () => {
    // Document X states set S. Document Y states no set and has document id S.
    // They are different documents, so their narratives must not share names.
    const withSet = await names(download(A));
    const idOnly = await names(download({ ...A, setId: null, documentId: A.setId! }));
    for (const [section, iri] of withSet.narrativeBySection) {
      expect(idOnly.narrativeBySection.get(section), section).not.toBe(iri);
    }
  });

  it('the same document id names the same narrative; a new id is a new document', async () => {
    const noSet = { ...A, setId: null };
    const a = await names(download(noSet));
    const again = await names(download({ ...noSet, idPrefix: B.idPrefix }));
    const other = await names(download({ ...noSet, documentId: 'DOC-DOWNLOAD-B' }));
    expect([...again.narrativeBySection]).toEqual([...a.narrativeBySection]);
    expect(other.narrativeBySection.get('11450-4')).not.toBe(a.narrativeBySection.get('11450-4'));
  });
});

describe('the id-reuse disambiguator hashes stable clinical fields only', () => {
  const ids = (n: Named, key: string): string[] => n.bySourceId.get(key) ?? [];
  const LAB = `health:LabResultRecord|${OID}.1.5555`;
  const PANEL = `clinical:LaboratoryReport|${OID}.5:PANEL-SHARED`;
  const ENC = `clinical:Encounter|${OID}.4:ENC-SHARED`;
  const PROBLEM = `health:ConditionRecord|${OID}.11:PROB-SHARED`;

  it('shared-id lab results keep their names when pointers and addresses move', async () => {
    const a = await names(download(A));
    const b = await names(download(B));
    expect(ids(a, LAB)).toHaveLength(2);
    expect(ids(b, LAB)).toEqual(ids(a, LAB));
  });

  it('shared-id lab panels keep their names with and without a nested visit wrapper', async () => {
    const a = await names(download(A));
    const b = await names(download(B));
    expect(ids(a, PANEL)).toHaveLength(2);
    expect(ids(b, PANEL)).toEqual(ids(a, PANEL));
  });

  it('shared-id encounters keep their names across downloads', async () => {
    const a = await names(download(A));
    const b = await names(download(B));
    expect(ids(a, ENC)).toHaveLength(2);
    expect(ids(b, ENC)).toEqual(ids(a, ENC));
  });

  it('shared-id medications keep their names across downloads', async () => {
    const a = await names(download(A));
    const b = await names(download(B));
    const meds = (n: Named) => [...cls(n, 'health:MedicationRecord'), ...cls(n, 'clinical:Medication')].sort();
    expect(meds(a)).toHaveLength(2);
    expect(meds(b)).toEqual(meds(a));
  });

  it('a panel listing its results in another order keeps its name', async () => {
    const a = await names(download(A));
    const b = await names(download({ ...B, reverseResults: true }));
    expect(ids(b, PANEL)).toEqual(ids(a, PANEL));
  });

  it('a bare citation minted while its id IS contradicted takes the plain id name', async () => {
    // The panel cites ENC-SHARED, which two encounters claim with different
    // content, by an `<encounter>` carrying only the id. That citation is
    // minted as an encounter too, and it has nothing to be told apart by, so it
    // takes the plain `{type}:{id}` name rather than a suffix hashed from
    // nothing (which would be one shared "empty" suffix for every such
    // citation of every id).
    const n = await names(download({ ...A, citeSharedEncounter: true }));
    const plain = `urn:uuid:${deterministicUuid(`Encounter:${OID}.4:ENC-SHARED`)}`;
    expect(ids(n, ENC)).toHaveLength(3);
    expect(ids(n, ENC)).toContain(plain);
  });

  it('a bare citation of a visit elsewhere does not contradict the visit\'s own id', async () => {
    // VISIT-88 is stated in full once, and cited by a medication as an
    // `<encounter>` carrying nothing but the id. The citation states no clinical
    // content, so it cannot disagree with the visit, and the visit is named from
    // its id alone, exactly as if the citation were absent.
    const plain = `urn:uuid:${deterministicUuid(`Encounter:${OID}.3:VISIT-88`)}`;
    for (const d of [A, B]) {
      const n = await names(download(d));
      expect(ids(n, `clinical:Encounter|${OID}.3:VISIT-88`)).toEqual([plain]);
    }
  });
});

describe('status is part of what a shared-id claimant says', () => {
  // Two statements under one id that agree on everything but their status are
  // two claims about the patient (active or resolved; taking or finished).
  // Folding them onto one subject gives it two status values.
  it('two same-id problems differing only in status are two records', async () => {
    const n = await names(download({ ...A, statusTwins: true }));
    expect(new Set(n.bySourceId.get(`health:ConditionRecord|${OID}.11:PROB-SHARED`)).size).toBe(2);
  });

  it('two same-id medications differing only in statusCode are two records', async () => {
    const n = await names(download({ ...A, statusTwins: true }));
    const meds = [...cls(n, 'health:MedicationRecord'), ...cls(n, 'clinical:Medication')];
    expect(new Set(meds).size).toBe(2);
  });

  it('CONTROL: the same statuses in a later download keep every name', async () => {
    const a = await names(download({ ...A, statusTwins: true }));
    // The visit wrapper is held equal here: whether it exists is not the question.
    const b = await names(download({ ...B, statusTwins: true, nestedEncounter: A.nestedEncounter }));
    expect([...b.bySourceId].sort()).toEqual([...a.bySourceId].sort());
  });
});

describe('CONTROL: genuinely different claimants of one id stay apart', () => {
  it('results, panels, encounters and medications that disagree clinically stay separate records', async () => {
    for (const d of [A, B]) {
      const n = await names(download(d));
      expect(new Set(n.bySourceId.get(`health:LabResultRecord|${OID}.1.5555`)).size).toBe(2);
      expect(new Set(n.bySourceId.get(`clinical:LaboratoryReport|${OID}.5:PANEL-SHARED`)).size).toBe(2);
      expect(new Set(n.bySourceId.get(`clinical:Encounter|${OID}.4:ENC-SHARED`)).size).toBe(2);
      expect(new Set(n.bySourceId.get(`health:ConditionRecord|${OID}.11:PROB-SHARED`)).size).toBe(2);
      const meds = [...cls(n, 'health:MedicationRecord'), ...cls(n, 'clinical:Medication')];
      expect(new Set(meds).size).toBe(2);
    }
  });
});
