/**
 * Synthetic C-CDA R2.1 documents for the C-CDA converter tests.
 *
 * AUTHORED FROM THE C-CDA R2.1 SPECIFICATION. Not derived from, edited from, or
 * de-identified from any real export. Every identifier, name, code and value
 * below is invented for this test suite.
 *
 * The two documents are BYTE-IDENTICAL except for the custodian organization
 * name, which is the only thing `detectVendor` keys on. That is deliberate:
 * running both through the same handlers isolates the vendor as the single
 * variable, which is exactly the axis along which the shape used to change.
 *
 * Sections and what each is here to exercise:
 *   - Vital Signs       — readings grouped in an <organizer> (8 observations)
 *   - Results           — two BATTERY <organizer> lab panels + an <encounter>
 *   - Family History    — two relatives, each an <organizer> with <relatedSubject>
 *   - Medical Equipment — an implanted device inside a <supply>
 *   - Problems          — an act/entryRelationship problem with a STATUS
 *                         observation that says "resolved", not the 'active' default
 *   - Procedures        — a <procedure> with a code, name and date
 *   - Allergies         — an allergen coded absent (<value nullFlavor="NI"/>) and
 *                         named only in the section narrative
 */

const BODY_WITH_CUSTODIAN = (custodianName: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <realmCode code="US"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.19.5" extension="SYNTH-DOC-001"/>
  <code code="34133-9" displayName="Summarization of Episode Note" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
  <title>Health Summary</title>
  <effectiveTime value="20260101120000+0000"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <languageCode code="en-US"/>
  <recordTarget>
    <patientRole>
      <id root="2.16.840.1.113883.19.5" extension="SYNTH-PATIENT-001"/>
      <patient>
        <name use="L"><given>Testpatient</given><family>Synthetic</family></name>
        <administrativeGenderCode code="F" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="19700101"/>
      </patient>
    </patientRole>
  </recordTarget>
  <custodian>
    <assignedCustodian>
      <representedCustodianOrganization>
        <id root="2.16.840.1.113883.19.5"/>
        <name>${custodianName}</name>
      </representedCustodianOrganization>
    </assignedCustodian>
  </custodian>
  <component>
    <structuredBody>

      <!-- Vital Signs Section -->
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.4.1"/>
          <code code="8716-3" displayName="Vital Signs" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
          <title>Vital Signs</title>
          <text>Office visit vitals 2026-01-01</text>
          <entry typeCode="DRIV">
            <organizer classCode="CLUSTER" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.26"/>
              <id root="2.16.840.1.113883.19.5" extension="SYNTH-VITAL-ORG-001"/>
              <code code="46680005" displayName="Vital signs" codeSystem="2.16.840.1.113883.6.96"/>
              <statusCode code="completed"/>
              <effectiveTime value="20260101"/>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.27"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-VITAL-OBS-HR"/>
                  <code code="8867-4" displayName="Heart rate" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
                  <statusCode code="completed"/>
                  <effectiveTime value="20260101"/>
                  <value xsi:type="PQ" value="72" unit="/min"/>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.27"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-VITAL-OBS-SBP"/>
                  <code code="8480-6" displayName="Systolic blood pressure" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
                  <statusCode code="completed"/>
                  <effectiveTime value="20260101"/>
                  <value xsi:type="PQ" value="118" unit="mm[Hg]"/>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.27"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-VITAL-OBS-DBP"/>
                  <code code="8462-4" displayName="Diastolic blood pressure" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
                  <statusCode code="completed"/>
                  <effectiveTime value="20260101"/>
                  <value xsi:type="PQ" value="76" unit="mm[Hg]"/>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.27"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-VITAL-OBS-TEMP"/>
                  <code code="8310-5" displayName="Body temperature" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
                  <statusCode code="completed"/>
                  <effectiveTime value="20260101"/>
                  <value xsi:type="PQ" value="36.8" unit="Cel"/>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.27"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-VITAL-OBS-RR"/>
                  <code code="9279-1" displayName="Respiratory rate" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
                  <statusCode code="completed"/>
                  <effectiveTime value="20260101"/>
                  <value xsi:type="PQ" value="16" unit="/min"/>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.27"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-VITAL-OBS-SPO2"/>
                  <code code="2708-6" displayName="Oxygen saturation in Arterial blood" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
                  <statusCode code="completed"/>
                  <effectiveTime value="20260101"/>
                  <value xsi:type="PQ" value="98" unit="%"/>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.27"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-VITAL-OBS-WT"/>
                  <code code="29463-7" displayName="Body weight" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
                  <statusCode code="completed"/>
                  <effectiveTime value="20260101"/>
                  <value xsi:type="PQ" value="70" unit="kg"/>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.27"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-VITAL-OBS-HT"/>
                  <code code="8302-2" displayName="Body height" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
                  <statusCode code="completed"/>
                  <effectiveTime value="20260101"/>
                  <value xsi:type="PQ" value="165" unit="cm"/>
                </observation>
              </component>
            </organizer>
          </entry>
        </section>
      </component>

      <!-- Results (labs) Section -->
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
          <code code="30954-2" displayName="Relevant Diagnostic Tests and/or Laboratory Data" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
          <title>Results</title>
          <text>Basic metabolic panel 2026-01-01</text>
          <entry typeCode="DRIV">
            <organizer classCode="BATTERY" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.1"/>
              <id root="2.16.840.1.113883.19.5" extension="SYNTH-LAB-ORG-BMP"/>
              <code code="51990-0" displayName="Basic metabolic panel" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
              <statusCode code="completed"/>
              <effectiveTime value="20260101"/>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-LAB-OBS-NA"/>
                  <code code="2951-2" displayName="Sodium [Moles/volume] in Serum or Plasma" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
                  <statusCode code="completed"/>
                  <effectiveTime value="20260101"/>
                  <value xsi:type="PQ" value="140" unit="mmol/L"/>
                  <interpretationCode code="N" codeSystem="2.16.840.1.113883.5.83"/>
                  <referenceRange><observationRange><text>135-145 mmol/L</text></observationRange></referenceRange>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-LAB-OBS-K"/>
                  <code code="2823-3" displayName="Potassium [Moles/volume] in Serum or Plasma" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
                  <statusCode code="completed"/>
                  <effectiveTime value="20260101"/>
                  <value xsi:type="PQ" value="4.1" unit="mmol/L"/>
                  <interpretationCode code="N" codeSystem="2.16.840.1.113883.5.83"/>
                  <referenceRange><observationRange><text>3.5-5.1 mmol/L</text></observationRange></referenceRange>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-LAB-OBS-CL"/>
                  <code code="2075-0" displayName="Chloride [Moles/volume] in Serum or Plasma" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
                  <statusCode code="completed"/>
                  <effectiveTime value="20260101"/>
                  <value xsi:type="PQ" value="102" unit="mmol/L"/>
                  <referenceRange><observationRange><text>98-107 mmol/L</text></observationRange></referenceRange>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-LAB-OBS-CREAT"/>
                  <code code="2160-0" displayName="Creatinine [Mass/volume] in Serum or Plasma" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
                  <statusCode code="completed"/>
                  <effectiveTime value="20260101"/>
                  <value xsi:type="PQ" value="0.9" unit="mg/dL"/>
                  <referenceRange><observationRange><text>0.6-1.1 mg/dL</text></observationRange></referenceRange>
                </observation>
              </component>
              <encounter classCode="ENC" moodCode="EVN">
                <id root="2.16.840.1.113883.19.5" extension="SYNTH-ENC-001"/>
                <code code="AMB" codeSystem="2.16.840.1.113883.5.4" displayName="Ambulatory"/>
                <effectiveTime value="20260101"/>
              </encounter>
            </organizer>
          </entry>
          <entry typeCode="DRIV">
            <organizer classCode="BATTERY" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.1"/>
              <id root="2.16.840.1.113883.19.5" extension="SYNTH-LAB-ORG-LIPID"/>
              <code code="57698-3" displayName="Lipid panel with direct LDL" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
              <statusCode code="completed"/>
              <effectiveTime value="20260101"/>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-LAB-OBS-CHOL"/>
                  <code code="2093-3" displayName="Cholesterol [Mass/volume] in Serum or Plasma" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
                  <statusCode code="completed"/>
                  <effectiveTime value="20260101"/>
                  <value xsi:type="PQ" value="180" unit="mg/dL"/>
                  <referenceRange><observationRange><text>less than 200 mg/dL</text></observationRange></referenceRange>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-LAB-OBS-HDL"/>
                  <code code="2085-9" displayName="Cholesterol in HDL [Mass/volume] in Serum or Plasma" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
                  <statusCode code="completed"/>
                  <effectiveTime value="20260101"/>
                  <value xsi:type="PQ" value="55" unit="mg/dL"/>
                  <referenceRange><observationRange><text>greater than 40 mg/dL</text></observationRange></referenceRange>
                </observation>
              </component>
            </organizer>
          </entry>
        </section>
      </component>

      <!-- Family History Section -->
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.15"/>
          <code code="10157-6" displayName="History of family member diseases" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
          <title>Family History</title>
          <text>Mother: Type 2 diabetes mellitus. Father: Myocardial infarction.</text>
          <entry typeCode="DRIV">
            <organizer classCode="CLUSTER" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.45"/>
              <id root="2.16.840.1.113883.19.5" extension="SYNTH-FHX-ORG-MOTHER"/>
              <statusCode code="completed"/>
              <subject>
                <relatedSubject classCode="PRS">
                  <code code="MTH" displayName="Mother" codeSystem="2.16.840.1.113883.5.111"/>
                  <subject>
                    <administrativeGenderCode code="F" codeSystem="2.16.840.1.113883.5.1"/>
                  </subject>
                </relatedSubject>
              </subject>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.46"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-FHX-OBS-MOTHER-DM"/>
                  <code code="64572001" displayName="Condition" codeSystem="2.16.840.1.113883.6.96"/>
                  <statusCode code="completed"/>
                  <value xsi:type="CD" code="44054006" displayName="Type 2 diabetes mellitus" codeSystem="2.16.840.1.113883.6.96"/>
                </observation>
              </component>
            </organizer>
          </entry>
          <entry typeCode="DRIV">
            <organizer classCode="CLUSTER" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.45"/>
              <id root="2.16.840.1.113883.19.5" extension="SYNTH-FHX-ORG-FATHER"/>
              <statusCode code="completed"/>
              <subject>
                <relatedSubject classCode="PRS">
                  <code code="FTH" displayName="Father" codeSystem="2.16.840.1.113883.5.111"/>
                  <subject>
                    <administrativeGenderCode code="M" codeSystem="2.16.840.1.113883.5.1"/>
                  </subject>
                </relatedSubject>
              </subject>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.46"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-FHX-OBS-FATHER-MI"/>
                  <code code="64572001" displayName="Condition" codeSystem="2.16.840.1.113883.6.96"/>
                  <statusCode code="completed"/>
                  <value xsi:type="CD" code="22298006" displayName="Myocardial infarction" codeSystem="2.16.840.1.113883.6.96"/>
                </observation>
              </component>
            </organizer>
          </entry>
        </section>
      </component>

      <!-- Allergies Section: allergen coded as absent, named only in the narrative -->
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.6.1"/>
          <code code="48765-2" displayName="Allergies and Adverse Reactions" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
          <title>Allergies</title>
          <text>
            <table>
              <tbody>
                <tr ID="allergy1">
                  <td ID="allergen1">Synthetic Test Allergen</td>
                  <td>Hives</td>
                </tr>
              </tbody>
            </table>
          </text>
          <entry typeCode="DRIV">
            <act classCode="ACT" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.30"/>
              <id root="2.16.840.1.113883.19.5" extension="SYNTH-ALLERGY-ACT-001"/>
              <code code="CONC" codeSystem="2.16.840.1.113883.5.6"/>
              <statusCode code="active"/>
              <entryRelationship typeCode="SUBJ">
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.7"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-ALLERGY-OBS-001"/>
                  <code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/>
                  <statusCode code="completed"/>
                  <value xsi:type="CD" nullFlavor="NI"/>
                  <participant typeCode="CSM">
                    <participantRole classCode="MANU">
                      <playingEntity classCode="MMAT">
                        <code nullFlavor="NI">
                          <originalText><reference value="#allergen1"/></originalText>
                        </code>
                      </playingEntity>
                    </participantRole>
                  </participant>
                </observation>
              </entryRelationship>
            </act>
          </entry>
        </section>
      </component>

      <!-- Problems Section: the status observation says RESOLVED, not the default -->
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
          <code code="11450-4" displayName="Problem List" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
          <title>Problems</title>
          <text>Acute bronchitis - resolved</text>
          <entry typeCode="DRIV">
            <act classCode="ACT" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
              <id root="2.16.840.1.113883.19.5" extension="SYNTH-PROBLEM-ACT-001"/>
              <code code="CONC" codeSystem="2.16.840.1.113883.5.6"/>
              <statusCode code="completed"/>
              <entryRelationship typeCode="SUBJ">
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-PROBLEM-OBS-001"/>
                  <code code="55607006" displayName="Problem" codeSystem="2.16.840.1.113883.6.96"/>
                  <statusCode code="completed"/>
                  <effectiveTime>
                    <low value="20240301"/>
                    <high value="20240401"/>
                  </effectiveTime>
                  <value xsi:type="CD" code="10509002" displayName="Acute bronchitis" codeSystem="2.16.840.1.113883.6.96"/>
                  <entryRelationship typeCode="REFR">
                    <observation classCode="OBS" moodCode="EVN">
                      <templateId root="2.16.840.1.113883.10.20.22.4.6"/>
                      <code code="33999-4" displayName="Status" codeSystem="2.16.840.1.113883.6.1"/>
                      <statusCode code="completed"/>
                      <value xsi:type="CD" code="413322009" displayName="Resolved" codeSystem="2.16.840.1.113883.6.96"/>
                    </observation>
                  </entryRelationship>
                </observation>
              </entryRelationship>
            </act>
          </entry>
        </section>
      </component>

      <!-- Procedures Section -->
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.7.1"/>
          <code code="47519-4" displayName="History of Procedures" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
          <title>Procedures</title>
          <text>Appendectomy 2019-04-12</text>
          <entry typeCode="DRIV">
            <procedure classCode="PROC" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.14"/>
              <id root="2.16.840.1.113883.19.5" extension="SYNTH-PROCEDURE-001"/>
              <code code="80146002" displayName="Appendectomy" codeSystem="2.16.840.1.113883.6.96" codeSystemName="SNOMED CT"/>
              <statusCode code="completed"/>
              <effectiveTime value="20190412"/>
            </procedure>
          </entry>
        </section>
      </component>

      <!-- Medical Equipment / Implanted Devices Section -->
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.23"/>
          <code code="46264-8" displayName="Medical Equipment" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
          <title>Medical Equipment</title>
          <text>Cardiac pacemaker implanted 2025-06-01</text>
          <entry typeCode="DRIV">
            <supply classCode="SPLY" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.50"/>
              <id root="2.16.840.1.113883.19.5" extension="SYNTH-DEVICE-001"/>
              <statusCode code="completed"/>
              <effectiveTime value="20250601"/>
              <participant typeCode="DEV">
                <participantRole classCode="MANU">
                  <id root="2.16.840.1.113883.19.5" extension="SYNTH-UDI-001"/>
                  <playingDevice>
                    <code code="14106009" displayName="Cardiac pacemaker" codeSystem="2.16.840.1.113883.6.96"/>
                  </playingDevice>
                </participantRole>
              </participant>
            </supply>
          </entry>
        </section>
      </component>

    </structuredBody>
  </component>
</ClinicalDocument>
`;

/** Custodian name contains "Epic", so `detectVendor` classifies this 'epic'. */
export const SYNTHETIC_EPIC_CCDA = BODY_WITH_CUSTODIAN('Epic Systems Sample Community Hospital');

/** Same document, a custodian no vendor rule matches: `detectVendor` -> 'unknown'. */
export const SYNTHETIC_UNKNOWN_VENDOR_CCDA = BODY_WITH_CUSTODIAN('Sample Community Hospital');
