/**
 * The one reader of a ClinicalDocument's plain-text narrative.
 *
 * The declared term is `clinical:narrativeText`, and it is the only spelling the
 * C-CDA converter writes. Pods written by earlier releases carry the same text
 * under two undeclared spellings instead: `cascade:narrativeText` and a
 * duplicate `clinical:content`. Those pods are never rewritten in place (a
 * source record is append-only), so a pod can hold the old spellings, the new
 * one, or all three on one subject after a re-import. Every reader goes through
 * this module so that all three read as one value.
 *
 * Precedence is fixed: the declared spelling wins, then the older undeclared
 * spelling, then the duplicate. When a subject carries more than one spelling
 * with different text, the declared spelling's text is the one returned.
 */

import { NS } from './fhir-converter/types.js';

/** The declared predicate. Writers use this and nothing else. */
export const NARRATIVE_TEXT_PREDICATE = NS.clinical + 'narrativeText';

/**
 * Every spelling a reader accepts, highest precedence first. The two legacy
 * entries are read-only: nothing may write them.
 */
const NARRATIVE_TEXT_READ_PREDICATES: readonly string[] = [
  NARRATIVE_TEXT_PREDICATE,
  NS.cascade + 'narrativeText',
  NS.clinical + 'content',
];

/**
 * The narrative text of one subject, given its properties keyed by full
 * predicate IRI (the shape `getProperties` returns). Returns the first
 * non-blank value of the highest-precedence spelling present, or undefined
 * when no spelling carries any text.
 */
export function readNarrativeText(props: Record<string, string[] | undefined>): string | undefined {
  for (const predicate of NARRATIVE_TEXT_READ_PREDICATES) {
    const text = props[predicate]?.find((v) => v.trim() !== '');
    if (text !== undefined) return text;
  }
  return undefined;
}
