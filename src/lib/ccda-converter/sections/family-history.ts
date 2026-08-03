/**
 * Extract family history from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.15)
 * Minimal implementation — narrative is preserved by the main converter.
 */

import { NS } from '../../fhir-converter/types.js';
import { firstOf, listOf } from '../multivalued.js';
import { ccdaRecordUri, ccdaSourceId } from '../record-identity.js';
import { resolveCodeUri } from '../code-systems.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const FAMILY_HISTORY_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.15';
export const FAMILY_HISTORY_LOINC = '10157-6';

/**
 * A family-history record describes a RELATIVE, not the pod's patient, which
 * makes it the section most exposed to losing the (removed) patient component
 * from its key. Measured, it is not: two sisters with the same diagnosis
 * ALREADY collided on `main` at every id level, because a patient component that
 * is constant within a pod cannot tell two of that pod's records apart. What
 * separates them now is the observation's own `<id>`, which the source assigns
 * per relative and which this section previously discarded — so honouring it
 * fixes the collision rather than causing it.
 *
 * The key additionally carries the relative's OWN id where the organizer's
 * `<relatedSubject>` supplies one, so two same-relation relatives separate even
 * when the source gave neither observation an id. Where it supplies none — the
 * residual case, unchanged from `main` — they still collapse; keying on the
 * relative's demographics is the remaining fix and is filed, not papered over.
 */
export function extractFamilyHistoryQuads(
  entries: any[],
  sourceSystem: string,
  _sectionText?: any,
  _importedAt?: string,
  warnings?: string[],
): Quad[] {
  const quads: Quad[] = [];
  const snomedOid = '2.16.840.1.113883.6.96';

  for (const entry of entries) {
    // `<organizer>` is a repeatable element and is therefore an ARRAY (see
    // `multivalued.ts`). This used to be `entry?.organizer ?? entry`, which
    // yielded the array itself, so `organizer.subject` and `organizer.component`
    // were both `undefined` and the whole section produced NOTHING. Measured on
    // a two-relative section: 0 quads before, 12 after.
    const organizer = firstOf<any>(entry?.organizer) ?? entry;
    if (!organizer) continue;

    // Family member relationship
    const subject = organizer?.subject?.relatedSubject;
    const relationCode = subject?.code ?? {};
    const relation = relationCode?.['@_displayName'] ?? relationCode?.displayName ?? '';

    // Observations within the organizer. `component` AND `observation` are both
    // always arrays from the parser's isArray config, so reading
    // `comp.observation` as an object made every field `undefined` and the whole
    // section produced NO records. Measured on the previous build: a family
    // history organizer yielded zero `health:FamilyHistoryRecord`s. The
    // conformance corpus carries no family history section, which is why the
    // section handler was never exercised against real parser output.
    const components = listOf<any>(organizer?.component);
    const observations = components.flatMap((comp: any) => listOf<any>(comp?.observation));
    for (const obs of observations) {
      if (!obs) continue;

      const valueEl = obs?.value ?? {};
      const code = valueEl?.['@_code'] ?? valueEl?.code ?? '';
      const codeSystem = valueEl?.['@_codeSystem'] ?? valueEl?.codeSystem ?? '';
      const displayName = valueEl?.['@_displayName'] ?? valueEl?.displayName ?? '';
      const isSnomed = codeSystem.includes('6.96') || codeSystem === snomedOid;

      if (!displayName && !code) continue;

      const sourceId = ccdaSourceId(obs?.id);

      const uri = ccdaRecordUri({
        type: 'FamilyHistory',
        sourceId,
        content: {
          relation: relation || undefined,
          condition: displayName || undefined,
          code: code || undefined,
          // The relative's own id, where the organizer carries one. Two sisters
          // are two subjects even when the source gave neither observation an id.
          relative: ccdaSourceId(subject?.id) ?? ccdaSourceId(subject?.subject?.id),
        },
        source: entry,
        warnings,
        label: 'C-CDA family history',
      });

      const subj = namedNode(uri);
      quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.health + 'FamilyHistoryRecord')));
      quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));
      if (relation) quads.push(makeQuad(subj, namedNode(NS.health + 'familyMember'), literal(relation)));
      if (displayName) quads.push(makeQuad(subj, namedNode(NS.health + 'conditionName'), literal(displayName)));
      if (isSnomed && code) quads.push(makeQuad(subj, namedNode(NS.health + 'snomedCode'), namedNode(resolveCodeUri(snomedOid, code))));
      if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
    }
  }

  return quads;
}
