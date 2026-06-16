/**
 * XML parser configuration for ClinVar VCV XML.
 *
 * ClinVar VCV exports follow the `<ClinVarResult-Set><VariationArchive>`
 * structure, with attribute-rich elements (Accession, VariationID,
 * DateLastEvaluated everywhere) and lots of repeating child elements
 * (RCVAccession, ClinicalAssertion, HGVS, XRef, etc.). The parser
 * needs:
 *   - Attribute preservation with a stable prefix.
 *   - Array normalization for elements that may appear once OR many
 *     times — without the isArray hint fast-xml-parser collapses
 *     single-instance children into bare objects, which makes
 *     downstream parsers nest a noisy `Array.isArray() ?` everywhere.
 *
 * This is intentionally a separate module so ClinVar parsing can swap
 * configurations (e.g., a VariationReport fork) without touching the
 * rest of the converter.
 */

import { XMLParser } from 'fast-xml-parser';

/** XML element names that must always be normalized into an array. */
const ALWAYS_ARRAY = new Set<string>([
  'VariationArchive',
  'Gene',
  'Citation',
  'XRef',
  'HGVS',
  'OtherName',
  'Name', // OtherNameList/Name and Trait Name; we sniff in code where needed
  'ProteinChange',
  'MolecularConsequence',
  'RCVAccession',
  'ClassifiedCondition',
  'ClinicalAssertion',
  'TraitSet',
  'Trait',
  'Symbol',
  'AttributeSet',
  'Attribute',
  'Comment',
  'ObservedIn',
  'ObservedData',
  'Method',
  'SequenceLocation',
  'SubmissionName',
  'AlleleFrequency',
  'GlobalMinorAlleleFrequency',
  'TraitMapping',
  'GermlineClassification',
  'SomaticClinicalImpact',
  'OncogenicityClassification',
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name: string) => ALWAYS_ARRAY.has(name),
  allowBooleanAttributes: true,
  parseAttributeValue: false, // keep numeric IDs as strings; we never math them
  parseTagValue: false,
  trimValues: true,
  // ClinVar VCV exports replace HTML entities (&gt; &lt;) thousands of
  // times across HGVS expressions and citation URLs. The parser's
  // default 1000-expansion safety limit trips on real-world VCVs
  // (BRCA1 alone trips it). Raise the ceilings to match production
  // ClinVar volume; we trust the input source (NCBI XML) so the
  // entity-expansion DoS scenario isn't a concern here.
  processEntities: {
    enabled: true,
    maxEntitySize: 10000,
    maxExpansionDepth: 10,
    maxTotalExpansions: 1_000_000,
    maxExpandedLength: 10_000_000,
    maxEntityCount: 100,
  },
});

/** Parse a ClinVar VCV XML string into a JS object tree. Throws on malformed XML. */
export function parseClinvarXml(xml: string): any {
  return xmlParser.parse(xml);
}
