/**
 * The encounter match key moves to `clinical:businessIdentifier`, and no pod is
 * stranded doing it.
 *
 * WHAT IS BEING MIGRATED, AND WHY IT IS DELICATE
 * ----------------------------------------------
 * A visit's identifier is written twice, in two different spellings:
 *
 *   clinical:businessIdentifier   FHIR token form, `{system}|{value}`, system
 *                                 VERBATIM. Canonical from clinical v1.16.
 *   cascade:sourceRecordId        colon form, `{system}:{value}`, `urn:oid:`
 *                                 stripped. FROZEN — the C-CDA path has always
 *                                 written this shape, and re-spelling it in
 *                                 place would unjoin every encounter pair
 *                                 already matched on it.
 *
 * So ONE identifier is TWO unequal strings. The whole risk of this migration is
 * that a matcher comparing across the forms fails silently in both directions:
 * it finds no match where one exists (`urn:oid:1.2.3|X` against `1.2.3:X`), and
 * it can find a match where none exists (a system-less token-form value that
 * happens to contain a colon, read as a colon-form `system:value`). Neither
 * shows up as an error; both show up as a pod that is quietly wrong about how
 * many visits a person had.
 *
 * THE RULE, STATED ONCE: values are compared only against values from the SAME
 * predicate, in that predicate's own form, and no code path converts between the
 * forms. These cases hold that rule from the outside — through
 * `runReconciliation`, not against the private matcher — so they keep holding if
 * the internals are rearranged.
 *
 * THREE POPULATIONS COEXIST during the transition and each is a case below:
 * records written after this release (both predicates), records written by a pod
 * repaired before it (frozen predicate only), and one of each. All three must
 * converge, which is the reason the frozen predicate is still dual-written.
 *
 * All data is synthetic and PHI-free; the identifier OIDs are in the example-use
 * `.999.` arc.
 */

import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { runReconciliation } from '../src/lib/reconciler.js';

const CLINICAL = 'https://ns.cascadeprotocol.org/clinical/v1#';
const CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';
const ENCOUNTER_TYPE = CLINICAL + 'Encounter';

const PREFIXES = `@prefix cascade: <${CASCADE}> .
@prefix clinical: <${CLINICAL}> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

const OID = '1.2.840.114350.1.13.999.2.7.3.698084.8';
const CSN = '20100000001';
/** The same identifier, in each predicate's own form. */
const TOKEN_FORM = `urn:oid:${OID}|${CSN}`;
const COLON_FORM = `${OID}:${CSN}`;

interface EncounterOpts {
  subject: string;
  system: string;
  /** Value for `clinical:businessIdentifier`, omitted for a pre-v1.16 record. */
  businessIdentifier?: string;
  /** Value for the frozen `cascade:sourceRecordId`, omitted to test in isolation. */
  legacyIdentifier?: string;
}

function encounter(o: EncounterOpts): string {
  const lines = [
    `<${o.subject}> a clinical:Encounter`,
    `  cascade:sourceSystem "${o.system}"`,
    `  cascade:sourceIdentity "org:northgate"`,
    `  cascade:dataProvenance cascade:EHRVerified`,
    `  cascade:schemaVersion "1.0"`,
    `  clinical:encounterType "Office Visit"`,
    `  clinical:encounterStart "2025-04-01T16:00:00Z"^^xsd:dateTime`,
  ];
  if (o.businessIdentifier) lines.push(`  clinical:businessIdentifier "${o.businessIdentifier}"`);
  if (o.legacyIdentifier) lines.push(`  cascade:sourceRecordId "${o.legacyIdentifier}"`);
  return `${lines.join(' ;\n')} .\n`;
}

async function encounterSubjectCount(...docs: string[]): Promise<number> {
  const result = await runReconciliation(
    docs.map((content, i) => ({ content: PREFIXES + content, systemName: `sys-${i}` })),
  );
  const quads = new Parser().parse(result.turtle);
  return new Set(
    quads
      .filter((q) => q.predicate.value.endsWith('22-rdf-syntax-ns#type') && q.object.value === ENCOUNTER_TYPE)
      .map((q) => q.subject.value),
  ).size;
}

describe('the canonical predicate is a match key', () => {
  it('two records sharing only a businessIdentifier are one visit', async () => {
    // The migration's whole point. Neither record states the frozen predicate,
    // so before this change nothing joined them and the pod held two visits.
    const count = await encounterSubjectCount(
      encounter({ subject: 'urn:uuid:11111111-1111-5111-8111-111111111111', system: 'fhir-pull', businessIdentifier: TOKEN_FORM }),
      encounter({ subject: 'urn:uuid:22222222-2222-5222-8222-222222222222', system: 'ccda-export', businessIdentifier: TOKEN_FORM }),
    );
    expect(count).toBe(1);
  });

  it('two records with DIFFERENT businessIdentifiers stay two visits', async () => {
    const count = await encounterSubjectCount(
      encounter({ subject: 'urn:uuid:11111111-1111-5111-8111-111111111111', system: 'fhir-pull', businessIdentifier: TOKEN_FORM }),
      encounter({ subject: 'urn:uuid:22222222-2222-5222-8222-222222222222', system: 'ccda-export', businessIdentifier: `urn:oid:${OID}|20100000999` }),
    );
    expect(count).toBe(2);
  });

  it('identifier SETS need only intersect, because the element is 0..*', async () => {
    // A resource publishing three identifiers has three, and a transport keying
    // on the second of them must still join.
    const a = `<urn:uuid:11111111-1111-5111-8111-111111111111> a clinical:Encounter ;
  cascade:sourceSystem "fhir-pull" ;
  cascade:sourceIdentity "org:northgate" ;
  cascade:dataProvenance cascade:EHRVerified ;
  cascade:schemaVersion "1.0" ;
  clinical:businessIdentifier "urn:oid:1.2.3|OTHER" ;
  clinical:businessIdentifier "${TOKEN_FORM}" .
`;
    const count = await encounterSubjectCount(
      a,
      encounter({ subject: 'urn:uuid:22222222-2222-5222-8222-222222222222', system: 'ccda-export', businessIdentifier: TOKEN_FORM }),
    );
    expect(count).toBe(1);
  });
});

describe('the frozen predicate still matches, so no repaired pod is stranded', () => {
  it('two pre-v1.16 records sharing only cascade:sourceRecordId are still one visit', async () => {
    // The compatibility read. These records were written before this release and
    // will keep arriving from any pod not yet re-imported.
    const count = await encounterSubjectCount(
      encounter({ subject: 'urn:uuid:11111111-1111-5111-8111-111111111111', system: 'fhir-pull', legacyIdentifier: COLON_FORM }),
      encounter({ subject: 'urn:uuid:22222222-2222-5222-8222-222222222222', system: 'ccda-export', legacyIdentifier: COLON_FORM }),
    );
    expect(count).toBe(1);
  });

  it('a post-release record joins a pre-release one through the frozen predicate', async () => {
    // The mixed population, and the reason `cascade:sourceRecordId` is still
    // dual-written rather than retired in this change: the canonical predicate
    // alone would have nothing on the old record to intersect with.
    const count = await encounterSubjectCount(
      encounter({
        subject: 'urn:uuid:11111111-1111-5111-8111-111111111111',
        system: 'fhir-pull',
        businessIdentifier: TOKEN_FORM,
        legacyIdentifier: COLON_FORM,
      }),
      encounter({ subject: 'urn:uuid:22222222-2222-5222-8222-222222222222', system: 'ccda-export', legacyIdentifier: COLON_FORM }),
    );
    expect(count).toBe(1);
  });
});

describe('the two forms are never compared against each other', () => {
  it('the token form and the colon form of ONE identifier do not join across predicates', async () => {
    // This is the case a pooled-bag matcher gets wrong in the direction that
    // looks like success: the identifiers ARE the same visit, but each record
    // states it on a different predicate in a different form, and there is no
    // sound way to recover one form from the other. The honest answer is two
    // subjects and no invented merge — which is exactly why converters
    // DUAL-EMIT rather than switching predicates, so this situation does not
    // arise from this codebase's own output.
    const count = await encounterSubjectCount(
      encounter({ subject: 'urn:uuid:11111111-1111-5111-8111-111111111111', system: 'fhir-pull', businessIdentifier: TOKEN_FORM }),
      encounter({ subject: 'urn:uuid:22222222-2222-5222-8222-222222222222', system: 'ccda-export', legacyIdentifier: COLON_FORM }),
    );
    expect(count).toBe(2);
  });

  it('a colon-shaped token-form value does not join a colon-form value that reads the same', async () => {
    // The other direction, and the dangerous one. `Encounter.identifier` with no
    // system is written BARE in token form, so a bare value that happens to
    // contain a colon renders identically to a colon-form `system:value` — and
    // they are unrelated identifiers. A matcher that split on separators or
    // pooled the forms would merge two different visits here.
    const count = await encounterSubjectCount(
      encounter({ subject: 'urn:uuid:11111111-1111-5111-8111-111111111111', system: 'fhir-pull', businessIdentifier: 'ACME:4471' }),
      encounter({ subject: 'urn:uuid:22222222-2222-5222-8222-222222222222', system: 'ccda-export', legacyIdentifier: 'ACME:4471' }),
    );
    expect(count).toBe(2);
  });

  it('an encounter stating no identifier at all still never merges', async () => {
    // Unchanged by the migration, and restated because it is the property that
    // stops "Office Visit on 2025-04-01" from collapsing two genuinely separate
    // visits. Absence of a join key is not evidence of a match.
    const count = await encounterSubjectCount(
      encounter({ subject: 'urn:uuid:11111111-1111-5111-8111-111111111111', system: 'fhir-pull' }),
      encounter({ subject: 'urn:uuid:22222222-2222-5222-8222-222222222222', system: 'ccda-export' }),
    );
    expect(count).toBe(2);
  });
});
