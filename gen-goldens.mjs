import { contentHashedUri, medicationUri, encounterParticipantUri } from './dist/lib/fhir-converter/types.js';
const cases = [
  ['FHIR Patient', () => contentHashedUri('Patient', { dob:'1985-03-15', sex:'male', name:'n-8f3a', identifier:'i-2b7c', maritalStatus:'M', address:'a-91de', deceased:undefined })],
  ['FHIR Condition', () => contentHashedUri('Condition', { patient:'urn:uuid:pat-1', code:'http://snomed.info/sct|44054006', onset:'2019-06-01T09:30:00Z', abatement:undefined, clinicalStatus:'active', verificationStatus:'confirmed', category:'problem-list-item', encounter:'Encounter/e1', note:'nt-77aa' })],
  ['FHIR Observation (lab)', () => contentHashedUri('Observation', { patient:'urn:uuid:pat-1', loincCode:'2339-0', effective:'2024-01-10T07:00:00Z', value:'95 mg/dL', specimen:'Specimen/s1', category:'laboratory', status:'final' })],
  ['FHIR Immunization', () => contentHashedUri('Immunization', { patient:'Patient/p1', vaccine:'http://hl7.org/fhir/sid/cvx|140', occurrence:'2023-10-02', status:'completed', lotNumber:'AB-1234', dose:'d-4411', site:'LA', route:'IM', manufacturer:'Acme Biologics', encounter:'Encounter/e2', performer:'Dr. Okoye', location:'Clinic North', note:'nt-1234' })],
  ['FHIR AllergyIntolerance', () => contentHashedUri('AllergyIntolerance', { patient:'Patient/p1', code:'http://snomed.info/sct|91936005', clinicalStatus:'active', verificationStatus:'confirmed', type:'allergy', category:'medication', criticality:'high', onset:'2011-04-02', reaction:'rx-55ff', note:'nt-9090' })],
  ['Medication (shared key)', () => medicationUri({ rxNormCode:'314076', medicationName:'Lisinopril 10 MG Oral Tablet', startDate:'2022-02-01', patient:'urn:uuid:pat-1' })],
  ['EncounterParticipant', () => encounterParticipantUri('urn:uuid:enc-1', { name:'Amara Okoye, MD', role:'attender', roleCodes:['PPRF','ATND'], specialty:'Cardiology' })],
  ['C-CDA LabResult', () => contentHashedUri('LabResult', { loincCode:'2339-0', testName:'Glucose', value:'95', unit:'mg/dL', effective:'20240110070000', refRange:'70-99' })],
  ['C-CDA problem', () => contentHashedUri('Condition', { conditionName:'Type 2 diabetes mellitus', snomedCode:'44054006', icd10Code:'E11.9', onsetDate:'2019-06-01', status:'active' })],
  ['C-CDA narrative section', () => contentHashedUri('ClinicalDocument', { document:'urn:uuid:doc-1', section:'11450-4', source:'sec-hash-abc' })],
  ['C-CDA patient', () => contentHashedUri('Patient', { name:'Jane Q Public', dob:'19850315', sex:'F', address:'a-77bb', telecom:'tel:+15555550123' })],
  ['C-CDA lab panel', () => contentHashedUri('LaboratoryReport', { panelCode:'24323-8', panelName:'Comprehensive metabolic panel', date:'20240110', effective:'20240110070000', members:'m-3311', encounters:'e-4422' })],
];
for (const [name, fn] of cases) console.log(name + '\t' + fn());
