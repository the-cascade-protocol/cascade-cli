/**
 * Three places the C-CDA path answered a question it had not been asked, and one
 * where it under-reported what it had done.
 *
 * Each is a case where the OUTPUT looked fine and the STATEMENT about it did not
 * match. None of them is a crash, a violation or a dropped record, which is why
 * a green suite could hold all four:
 *
 *   - A malformed `effectiveTime` was salvaged down to its calendar day and the
 *     day was then reported as though the source had stated it, with no warning.
 *   - A section carrying `nullFlavor="NI"` — the ratified way of saying "no
 *     information" — was queued for LLM extraction, i.e. a model was to be handed
 *     the sentence "No information available." and asked what it contained.
 *   - A narrative `<reference>` pointing at an ID the section does not declare
 *     resolved to nothing in silence, so in the pod it is indistinguishable from
 *     a record that was never named anywhere.
 *   - `resourceCount` counted documents-and-sections while the FHIR importer
 *     counted records, so one field meant two things depending on `--from`.
 *
 * Every document below is authored for this test: invented people,
 * organizations, identifiers, dates and values.
 */

import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { convertCcda } from '../src/lib/ccda-converter/index.js';
import { ccdaDateQuad } from '../src/lib/ccda-converter/dates.js';
import {
  buildNarrativeIdMap,
  narrativeTextFor,
} from '../src/lib/ccda-converter/narrative-reference.js';
import { parseCcdaXml } from '../src/lib/ccda-converter/parser.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';
const HEALTH = 'https://ns.cascadeprotocol.org/health/v1#';

/**
 * A minimal but conformant C-CDA carrying one Results section whose organizer
 * holds `observations`, plus whatever extra sections `extraSections` adds.
 */
function document(observations: string, extraSections = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.19.5.77771.1" extension="HONESTY-001"/>
  <code code="34133-9" displayName="Summarization of Episode Note" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
  <title>Fernbrook Health Summary</title>
  <effectiveTime value="20250704091500-0500"/>
  <recordTarget>
    <patientRole>
      <id root="2.16.840.1.113883.19.5.77771.2" extension="MRN-4402"/>
      <patient>
        <name use="L"><given>Ottoline</given><family>Vasquez-Hale</family></name>
        <administrativeGenderCode code="F" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="19750618"/>
      </patient>
    </patientRole>
  </recordTarget>
  <custodian>
    <assignedCustodian>
      <representedCustodianOrganization>
        <id root="2.16.840.1.113883.19.5.77771.1"/>
        <name>Fernbrook Health</name>
      </representedCustodianOrganization>
    </assignedCustodian>
  </custodian>
  <component>
    <structuredBody>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
          <code code="30954-2" displayName="Relevant Diagnostic Tests and/or Laboratory Data" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
          <title>Results</title>
          <text>
            <table><tbody>
              <tr><td><content ID="fbname1">Sodium</content></td><td>140 mmol/L</td></tr>
            </tbody></table>
          </text>
          <entry typeCode="DRIV">
            <organizer classCode="BATTERY" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.1"/>
              <id root="2.16.840.1.113883.19.5.77771.4" extension="FB-ORG"/>
              <code code="24323-8" displayName="Comprehensive metabolic panel" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
              <statusCode code="completed"/>
              <effectiveTime value="20250704"/>
${observations}
            </organizer>
          </entry>
        </section>
      </component>
${extraSections}
    </structuredBody>
  </component>
</ClinicalDocument>`;
}

/** One lab observation inside the organizer above. */
function observation(extension: string, code: string, effectiveTime: string, codeBody = ''): string {
  return `              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
                  <id root="2.16.840.1.113883.19.5.77771.5" extension="${extension}"/>
                  <code code="${code}" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC">${codeBody}</code>
                  <statusCode code="completed"/>
                  <effectiveTime value="${effectiveTime}"/>
                  <value xsi:type="PQ" value="140" unit="mmol/L"/>
                </observation>
              </component>`;
}

const ALLERGIES_NULLFLAVOR = `      <component>
        <section nullFlavor="NI">
          <templateId root="2.16.840.1.113883.10.20.22.2.6.1"/>
          <code code="48765-2" displayName="Allergies, Adverse Reactions, Alerts" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
          <title>Allergies</title>
          <text>No information available.</text>
        </section>
      </component>`;

/** The same section WITHOUT the nullFlavor: genuinely narrative-only. */
const ALLERGIES_NARRATIVE_ONLY = ALLERGIES_NULLFLAVOR.replace(' nullFlavor="NI"', '');

function objectsOf(turtle: string, predicate: string): string[] {
  return new Parser({ format: 'Turtle' })
    .parse(turtle)
    .filter((q) => q.predicate.value === predicate)
    .map((q) => q.object.value)
    .sort();
}

function recordSubjects(turtle: string): Set<string> {
  return new Set(
    new Parser({ format: 'Turtle' })
      .parse(turtle)
      .filter((q) => q.predicate.value === RDF_TYPE)
      .map((q) => q.subject.value),
  );
}

// ---------------------------------------------------------------------------

describe('a salvaged date is reported as salvaged', () => {
  it('warns, names the offending value, and still emits the day', async () => {
    const result = await convertCcda(
      document(observation('FB-BAD-DATE', '2951-2', '202507041')),
    );

    // The day survives — throwing a record's date away over a stray digit loses
    // more than it saves.
    expect(objectsOf(result.output, HEALTH + 'performedDate')).toContain('2025-07-04');
    // And the value the source got wrong is named, so a reader can tell a stated
    // date from a recovered one.
    const salvaged = result.warnings.filter((w) => w.includes('202507041'));
    expect(salvaged).toHaveLength(1);
  });

  it('says nothing about a well-formed day', async () => {
    const result = await convertCcda(document(observation('FB-GOOD-DATE', '2951-2', '20250704')));
    expect(result.warnings.filter((w) => w.includes('malformed'))).toEqual([]);
  });

  it('carries the warning through the quad helper, which is where callers get it', () => {
    // Pins the ARGUMENT: the helper only warns because a `warnings` array was
    // passed to it. Every section handler passes one, and a handler that stops
    // doing so goes silent again without changing a single emitted triple.
    const warnings: string[] = [];
    const quad = ccdaDateQuad('urn:x', HEALTH + 'performedDate', '202507041', warnings);
    expect(quad?.object.value).toBe('2025-07-04');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('202507041');

    const silent: string[] = [];
    ccdaDateQuad('urn:x', HEALTH + 'performedDate', '20250704', silent);
    expect(silent).toEqual([]);
  });
});

describe('a section that says it holds no information is not queued for extraction', () => {
  it('leaves requiresLLMExtraction false for a nullFlavor section', async () => {
    const result = await convertCcda(
      document(observation('FB-1', '2951-2', '20250704'), ALLERGIES_NULLFLAVOR),
    );
    expect(objectsOf(result.output, CASCADE + 'requiresLLMExtraction')).toEqual(['false', 'false']);
  });

  it('still queues an entry-less section that made no such statement', async () => {
    // The contrast is the whole point: a narrative-only section IS worth
    // reading, and a fix that stopped queueing everything would be a different,
    // larger change.
    const result = await convertCcda(
      document(observation('FB-1', '2951-2', '20250704'), ALLERGIES_NARRATIVE_ONLY),
    );
    expect(objectsOf(result.output, CASCADE + 'requiresLLMExtraction')).toEqual(['false', 'true']);
  });
});

describe('a narrative reference that resolves to nothing says so', () => {
  it('warns naming the reference, and still invents no name', async () => {
    const dangling = '<originalText><reference value="#fbmissing"/></originalText>';
    const result = await convertCcda(
      document(observation('FB-DANGLING', '2951-2', '20250704', dangling)),
    );

    expect(result.warnings.filter((w) => w.includes('#fbmissing'))).toHaveLength(1);
    // No fabricated name: naming it from the LOINC code would invent the
    // attested rendering, which is the thing the reference pointed at.
    expect(objectsOf(result.output, HEALTH + 'testName')).toEqual([]);
  });

  it('says nothing when the reference resolves', async () => {
    const resolvable = '<originalText><reference value="#fbname1"/></originalText>';
    const result = await convertCcda(
      document(observation('FB-RESOLVES', '2951-2', '20250704', resolvable)),
    );

    expect(objectsOf(result.output, HEALTH + 'testName')).toEqual(['Sodium']);
    expect(result.warnings.filter((w) => w.includes('does not resolve'))).toEqual([]);
  });

  it('warns from the resolver itself only when a warnings array is passed', () => {
    const section = parseCcdaXml(
      `<section><text><content ID="a">Sodium</content></text></section>`,
    ).section;
    const map = buildNarrativeIdMap(section.text);

    const warnings: string[] = [];
    expect(narrativeTextFor({ reference: { '@_value': '#nope' } }, map, warnings)).toBe('');
    expect(warnings).toHaveLength(1);

    // Resolvable: no warning, and the resolved text.
    const quiet: string[] = [];
    expect(narrativeTextFor({ reference: { '@_value': '#a' } }, map, quiet)).toBe('Sodium');
    expect(quiet).toEqual([]);
  });
});

describe('resourceCount means the same thing for every importer', () => {
  it('counts the records produced, not the entries read', async () => {
    // ONE <entry>, whose organizer holds three observations. The old count was
    // 1 (patient) + entries.length (1) = 2, for a document that produces the
    // patient, the Results section's narrative document, the laboratory report
    // and three results: six records, reported as two.
    const result = await convertCcda(
      document(
        [
          observation('FB-1', '2951-2', '20250704'),
          observation('FB-2', '2823-3', '20250704'),
          observation('FB-3', '2075-0', '20250704'),
        ].join('\n'),
      ),
    );

    expect(result.resourceCount).toBe(recordSubjects(result.output).size);
    expect(result.resourceCount).toBe(6);
  });
});
