/**
 * XML parser for C-CDA documents.
 * Uses fast-xml-parser with attribute support and array normalization.
 *
 * The array normalization here is the ONLY place a repeatable element's shape is
 * decided. It reads its element list from `multivalued.ts`, which the vendor
 * shims read too, so the two can no longer disagree about whether (say)
 * `<organizer>` is an array. See the header of that file for what went wrong
 * while they could.
 */

import { XMLParser } from 'fast-xml-parser';
import { isMultivaluedElement } from './multivalued.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name: string) => isMultivaluedElement(name),
  allowBooleanAttributes: true,
});

export function parseCcdaXml(xml: string): any {
  return xmlParser.parse(xml);
}
