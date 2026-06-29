/**
 * Tests for the native C-CDA importer's provenance + required-field fixes that
 * make Epic MyChart exports pass SHACL validation:
 *
 *  - cascade:dataProvenance + cascade:schemaVersion on every record (shared pass)
 *  - clinical:ClinicalDocument required fields (importedAt, sourceEHR,
 *    fhirResourceId, fhirResourceType)
 *  - clinical:drugName resolved from the medication narrative reference
 *  - cascade:dateOfBirth (xsd:date) + cascade:biologicalSex (enum) on the patient
 *  - clinical:sourceEHR derived from the custodian organization
 *  - clinical:vitalType enum mapping, with non-enum vitals re-routed to lab
 *    results rather than dropped
 */

import { describe, it, expect } from 'vitest';
import { convertCcda } from '../src/lib/ccda-converter/index.js';
import { loadShapes, validateTurtle } from '../src/lib/shacl-validator.js';

// A minimal but realistic Epic-style C-CDA: custodian org, patient demographics,
// a medication whose drug name lives in the narrative (originalText reference),
// an enum vital (heart rate), and a non-enum vital (mean blood pressure, LOINC
// 8478-0, which is NOT in the VitalSignShape enum and must re-route to a lab).
const CCDA = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1" displayName="Summarization of Episode Note"/>
  <id root="9.8.7.6.5" extension="DOC-TEST-1"/>
  <custodian>
    <assignedCustodian>
      <representedCustodianOrganization>
        <id root="1.2.3.4"/>
        <name>Providence Health and Services Washington and Montana</name>
      </representedCustodianOrganization>
    </assignedCustodian>
  </custodian>
  <recordTarget>
    <patientRole>
      <id root="1.2.3" extension="MRN-1"/>
      <patient>
        <name><given>Jane</given><family>Doe</family></name>
        <administrativeGenderCode code="F" codeSystem="2.16.840.1.113883.5.1" displayName="Female"/>
        <birthTime value="19650101"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component>
    <structuredBody>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.1.1"/>
          <code code="10160-0" codeSystem="2.16.840.1.113883.6.1" displayName="Medications"/>
          <title>Medications</title>
          <text>
            <table><tbody>
              <tr><td><paragraph ID="med1">cholecalciferol (VITAMIN D-3) 25 mcg tablet</paragraph></td></tr>
            </tbody></table>
          </text>
          <entry>
            <substanceAdministration classCode="SBADM" moodCode="EVN">
              <id root="1.2.3.4.5" extension="MED-1"/>
              <effectiveTime xsi:type="IVL_TS"><low value="20240101"/></effectiveTime>
              <consumable>
                <manufacturedProduct>
                  <manufacturedMaterial>
                    <code code="199362" codeSystem="2.16.840.1.113883.6.88" codeSystemName="RxNorm">
                      <originalText><reference value="#med1"/></originalText>
                    </code>
                  </manufacturedMaterial>
                </manufacturedProduct>
              </consumable>
            </substanceAdministration>
          </entry>
        </section>
      </component>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.4.1"/>
          <code code="8716-3" codeSystem="2.16.840.1.113883.6.1" displayName="Vital signs"/>
          <title>Vital Signs</title>
          <text><table><tbody><tr><td>Heart Rate</td><td>67</td></tr></tbody></table></text>
          <entry>
            <organizer classCode="CLUSTER" moodCode="EVN">
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <id root="1.2.3.4.6" extension="VIT-1"/>
                  <code code="8867-4" codeSystem="2.16.840.1.113883.6.1"><originalText>Heart rate</originalText></code>
                  <effectiveTime value="20240101120000+0000"/>
                  <value xsi:type="PQ" unit="/min" value="67"/>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <id root="1.2.3.4.6" extension="VIT-2"/>
                  <code code="8478-0" codeSystem="2.16.840.1.113883.6.1"><originalText>Mean blood pressure</originalText></code>
                  <effectiveTime value="20240101120000+0000"/>
                  <value xsi:type="PQ" unit="mm[Hg]" value="94"/>
                </observation>
              </component>
            </organizer>
          </entry>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>`;

const IMPORTED_AT = '2026-06-28T12:00:00Z';

async function convert() {
  return convertCcda(CCDA, { sourceSystem: 'ImportBatchLabel', importedAt: IMPORTED_AT });
}

describe('C-CDA shared provenance pass', () => {
  it('emits cascade:dataProvenance + cascade:schemaVersion on every typed record', async () => {
    const { output } = await convert();
    // Count rdf:type subjects vs provenance/schemaVersion occurrences.
    const typeCount = (output.match(/\ba (clinical:|health:|cascade:)/g) ?? []).length;
    const provCount = (output.match(/cascade:dataProvenance cascade:ClinicalGenerated/g) ?? []).length;
    const verCount = (output.match(/cascade:schemaVersion "1\.\d+"/g) ?? []).length;
    expect(typeCount).toBeGreaterThan(0);
    expect(provCount).toBe(typeCount);
    expect(verCount).toBe(typeCount);
  });

  it('does not duplicate provenance on records that already have it', async () => {
    const { output } = await convert();
    // No subject should carry two dataProvenance triples — the n3 writer would
    // render that as a comma list. A simple proxy: provenance count == type count
    // (asserted above) and the medication block keeps exactly one each.
    const medProv = (output.match(/clinical:Medication[\s\S]*?\./g) ?? [])
      .join('')
      .match(/cascade:dataProvenance/g);
    expect((medProv ?? []).length).toBeLessThanOrEqual(1);
  });
});

describe('C-CDA ClinicalDocument required fields', () => {
  it('emits importedAt, fhirResourceId, fhirResourceType, sourceEHR', async () => {
    const { output } = await convert();
    expect(output).toContain('clinical:importedAt');
    expect(output).toContain('"2026-06-28T12:00:00Z"');
    expect(output).toContain('clinical:fhirResourceType "DocumentReference"');
    expect(output).toMatch(/clinical:fhirResourceId "[^"]+"/);
    expect(output).toContain('clinical:sourceEHR "Providence Health and Services Washington and Montana"');
  });
});

describe('C-CDA medication drug name from narrative', () => {
  it('resolves clinical:drugName from the originalText reference', async () => {
    const { output } = await convert();
    expect(output).toContain('clinical:drugName "cholecalciferol (VITAMIN D-3) 25 mcg tablet"');
  });
});

describe('C-CDA patient demographics', () => {
  it('emits typed dateOfBirth and enum biologicalSex', async () => {
    const { output } = await convert();
    expect(output).toContain('cascade:dateOfBirth "1965-01-01"^^xsd:date');
    expect(output).toContain('cascade:biologicalSex "female"');
  });
});

describe('C-CDA sourceEHR derivation from custodian', () => {
  it('uses the custodian org name, not the import-batch label', async () => {
    const { output } = await convert();
    expect(output).toContain('clinical:sourceEHR "Providence Health and Services Washington and Montana"');
    // The import-batch label must NOT leak into sourceEHR.
    expect(output).not.toContain('clinical:sourceEHR "ImportBatchLabel"');
  });

  it('falls back to "unknown" when no custodian or author org is present', async () => {
    const noCustodian = CCDA.replace(/<custodian>[\s\S]*?<\/custodian>/, '');
    const { output } = await convertCcda(noCustodian, { sourceSystem: 'Batch', importedAt: IMPORTED_AT });
    expect(output).toContain('clinical:sourceEHR "unknown"');
  });
});

describe('C-CDA vital signs', () => {
  it('maps an enum vital (heart rate) to clinical:vitalType + clinical:value', async () => {
    const { output } = await convert();
    expect(output).toContain('clinical:vitalType "heartRate"');
    expect(output).toContain('clinical:value "67"');
  });

  it('re-routes a non-enum vital (mean BP) to a lab result, preserving its value', async () => {
    const { output } = await convert();
    // Mean blood pressure (LOINC 8478-0) is not in the VitalSignShape enum.
    // It must NOT appear as a VitalSign with vitalType "meanBloodPressure".
    expect(output).not.toContain('"meanBloodPressure"');
    // Its value (94) must survive on a LabResultRecord.
    expect(output).toContain('health:LabResultRecord');
    expect(output).toContain('health:resultValue "94"');
  });
});

describe('C-CDA full SHACL validation', () => {
  it('produces zero SHACL violations across all record types', async () => {
    const { output } = await convert();
    const { store, shapeFiles } = loadShapes();
    const validation = validateTurtle(output, store, shapeFiles, 'ccda-provenance-test');
    const violations = validation.results.filter((r) => r.severity === 'violation');
    expect(
      violations,
      `SHACL violations:\n${violations.map((v) => `  ${v.shape}: ${v.message} (${v.property})`).join('\n')}`,
    ).toHaveLength(0);
  });
});
