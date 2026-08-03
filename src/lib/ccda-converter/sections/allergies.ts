/**
 * Extract allergies from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.6.1)
 */

import { NS } from '../../fhir-converter/types.js';
import { firstOf, listOf } from '../multivalued.js';
import { ccdaRecordUri, ccdaSourceId } from '../record-identity.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const ALLERGIES_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.6.1';
export const ALLERGIES_LOINC = '48765-2';

export function extractAllergyQuads(
  entries: any[],
  sourceSystem: string,
  _sectionText?: any,
  _importedAt?: string,
  warnings?: string[],
): Quad[] {
  const quads: Quad[] = [];

  for (const entry of entries) {
    // entry.act is always an array from fast-xml-parser's isArray config — unwrap first element
    const act = firstOf<any>(entry?.act) ?? entry;
    // The allergy observation sits under `act/entryRelationship/observation` in
    // canonical C-CDA R2.1, and directly under `act/observation` in the looser
    // shape some exports (and this repo's own corpus fixture) use. BOTH have to
    // be walked, and `entryRelationship` is always an ARRAY from the parser's
    // isArray config — so `act?.entryRelationship?.observation` was always
    // `undefined` and the canonical nesting produced NO allergy record at all.
    // Measured on the previous build: a canonical allergy entry yielded zero
    // `health:AllergyRecord`s. `problems.ts` already walked it correctly; this
    // is the same walk.
    const entryRelArr = listOf<any>(act?.entryRelationship);
    const nested = entryRelArr.flatMap((er: any) => listOf<any>(er?.observation));
    const direct = listOf<any>(act?.observation);
    const obsArr = nested.length > 0 ? nested : (direct.length > 0 ? direct : [act]);

    for (const observation of obsArr) {
      // Allergen is typically in participant/playingEntity
      const participant = firstOf<any>(observation?.participant);
      const playingEntity = participant?.participantRole?.playingEntity ?? {};
      const allergenCode = playingEntity?.code ?? {};
      // `<name>` is a repeatable element and is therefore an ARRAY. The old read
      // was `playingEntity?.name?.['#text']`, which is `undefined` on an array,
      // so the human-readable allergen name the source wrote in `<name>` was
      // never used and the record fell back to the CODE's displayName. Both name
      // the same substance in a well-formed export, but they are not the same
      // string, and the one the source chose to show the patient is `<name>`.
      const playingEntityName = firstOf<any>(playingEntity?.name);
      const allergenName =
        (typeof playingEntityName === 'string'
          ? playingEntityName
          : playingEntityName?.['#text']) ??
        allergenCode?.['@_displayName'] ??
        allergenCode?.displayName ?? '';

      // Reaction/severity from entryRelationship
      const reactions = listOf<any>(observation?.entryRelationship);
      const severityObs = reactions
        .map((r: any) => ({ r, o: firstOf<any>(r?.observation) }))
        .find(({ r, o }: any) => o?.code?.['@_code'] === 'SEV' || r?.typeCode === 'SUBJ')?.o;
      const severityCode =
        severityObs?.value?.['@_displayName'] ?? severityObs?.value?.displayName ?? '';

      if (!allergenName) {
        // The allergen is not named anywhere this handler reads. In practice
        // that means the source coded it absent — `<value nullFlavor="NI"/>`
        // with a `<code nullFlavor=…>` whose `<originalText><reference
        // value="#…"/>` points into the section narrative, where the substance
        // IS written out in words.
        //
        // Dropping it was silent, and a silently dropped allergy is the worst
        // record in this converter to lose. It is no longer silent. What it is
        // not yet is RECOVERED.
        //
        // [JR: an unnamed allergy is now REPORTED but still not imported. Two
        //  ways to finish it, and I did not want to pick one for you:
        //    (a) resolve `<originalText><reference value="#id"/>` against the
        //        section's own <text> narrative and use the resolved string as
        //        the allergen name. Recovers the real substance, and this
        //        converter already parses section narrative
        //        (`narrative-extractor.ts`), so the machinery exists. Risk: the
        //        resolved string is display text, and it enters the identity key.
        //    (b) emit the AllergyRecord with no allergen name and a data-absent
        //        reason. FHIR's `dataAbsentReason` (http://hl7.org/fhir/
        //        ValueSet/data-absent-reason, code `unknown`) is the ratified
        //        anchor, and Cascade has no equivalent term today, so this needs
        //        a vocabulary addition authored in `spec/` first.
        //  MY RECOMMENDATION: (a) then (b) — resolve the reference, and fall back
        //  to (b) only when the reference does not resolve. (a) recovers the
        //  actual clinical fact, which is what the patient needs; (b) alone
        //  imports a record that says an allergy exists without saying to what,
        //  which is not much better than the warning below. Doing (a) first also
        //  keeps the vocabulary change off this fix's critical path.]
        const unnamedId = ccdaSourceId(act?.id) ?? ccdaSourceId(observation?.id);
        warnings?.push(
          'C-CDA allergy entry names no allergen in its structured data ' +
            `(${unnamedId ? `source id ${unnamedId}` : 'no source id'}${severityCode ? `, severity ${severityCode}` : ''}) ` +
            '— the substance is likely in the section narrative only. NOT imported.',
        );
        continue;
      }

      // The allergy CONCERN act carries the id in most exports; the reaction
      // observation carries its own where the act does not.
      const sourceId = ccdaSourceId(act?.id) ?? ccdaSourceId(observation?.id);

      const uri = ccdaRecordUri({
        type: 'Allergy',
        sourceId,
        content: {
          allergenName: allergenName.toLowerCase(),
          // Serialized as health:allergySeverity, so it has to be in the key:
          // a "mild" and a "severe" reaction to one allergen are two claims,
          // and merging them lets whichever was read first decide.
          severity: severityCode ? severityCode.toLowerCase() : undefined,
        },
        source: entry,
        warnings,
        label: 'C-CDA allergy',
      });

      const subj = namedNode(uri);
      quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.health + 'AllergyRecord')));
      quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));
      quads.push(makeQuad(subj, namedNode(NS.health + 'allergen'), literal(allergenName)));

      if (severityCode) quads.push(makeQuad(subj, namedNode(NS.health + 'allergySeverity'), literal(severityCode.toLowerCase())));
      if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
    }
  }

  return quads;
}
