/**
 * XML parser for C-CDA documents.
 * Uses fast-xml-parser with attribute support and array normalization.
 */

import { XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name: string) => {
    // These elements should always be arrays
    return [
      'entry', 'component', 'observation', 'substanceAdministration',
      'act', 'encounter', 'procedure', 'id', 'name', 'telecom', 'addr',
      'entryRelationship', 'participant',
    ].includes(name);
  },
  allowBooleanAttributes: true,
});

export function parseCcdaXml(xml: string): any {
  return xmlParser.parse(xml);
}
