/**
 * Extract procedures from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.7.1)
 */

import { NS } from '../../fhir-converter/types.js';
import { firstOf } from '../multivalued.js';
import { ccdaRecordUri, ccdaSourceId } from '../record-identity.js';
import { resolveCodeUri } from '../code-systems.js';
import { ccdaDateQuad } from '../dates.js';
import { buildNarrativeIdMap, resolveNarrativeName } from '../narrative-reference.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const PROCEDURES_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.7.1';
export const PROCEDURES_LOINC = '47519-4';

export function extractProcedureQuads(
  entries: any[],
  sourceSystem: string,
  sectionText?: any,
  _importedAt?: string,
  warnings?: string[],
): Quad[] {
  const quads: Quad[] = [];
  const snomedOid = '2.16.840.1.113883.6.96';
  const cptOid = '2.16.840.1.113883.6.12';
  const narrativeIdMap = buildNarrativeIdMap(sectionText);

  for (const entry of entries) {
    // `<procedure>` and `<act>` are both repeatable elements and are therefore
    // ARRAYS. This used to be `entry?.procedure ?? entry?.act ?? entry`, which
    // yielded the array, so `proc.code`, `proc.effectiveTime` and `proc.id` were
    // all `undefined`. Nothing guarded against that, so every procedure still
    // minted a record — carrying only its type and source system, with the
    // procedure NAME, DATE and CODE all silently dropped, and its identity
    // falling through to a content hash of the raw entry. Empty records reported
    // as a successful import is the same absence-as-success failure as the
    // zero-record sections; here it was harder to see because the count looked
    // right.
    const proc = firstOf<any>(entry?.procedure) ?? firstOf<any>(entry?.act) ?? entry;
    if (!proc) continue;

    const codeEl = proc?.code ?? {};
    const code = codeEl?.['@_code'] ?? codeEl?.code ?? '';
    const codeSystem = codeEl?.['@_codeSystem'] ?? codeEl?.codeSystem ?? '';
    const displayName = codeEl?.['@_displayName'] ?? codeEl?.displayName ?? '';
    // The same narrative recovery the results and problems sections do: a
    // procedure whose code carries no `@displayName` normally names itself in the
    // section narrative behind `<originalText><reference value="#id"/>`.
    const procedureName = displayName || resolveNarrativeName(codeEl, narrativeIdMap, warnings);

    const effTime = proc?.effectiveTime ?? {};
    const dateVal =
      effTime?.['@_value'] ?? effTime?.value ?? effTime?.low?.['@_value'] ?? '';
    const dateStr = dateVal.length >= 8
      ? `${dateVal.slice(0, 4)}-${dateVal.slice(4, 6)}-${dateVal.slice(6, 8)}`
      : dateVal;

    const sourceId = ccdaSourceId(proc?.id);

    const uri = ccdaRecordUri({
      type: 'Procedure',
      sourceId,
      content: {
        code: code || undefined,
        displayName: displayName || undefined,
        date: dateStr || undefined,
      },
      source: entry,
      warnings,
      label: 'C-CDA procedure',
    });

    const subj = namedNode(uri);
    quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'Procedure')));
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));
    // clinical:procedureName, NOT health:procedureName. The record above is typed
    // clinical:Procedure, clinical:ProcedureShape targets that class and names
    // this property, and clinical:procedureName is the only spelling any Cascade
    // vocabulary defines: health: has no procedure class and no procedure-name
    // property at all. Writing the health: spelling made every converted
    // procedure fail the shape's name requirement WHILE CARRYING A NAME, and put
    // that name on a predicate no shape targets, so the name itself was
    // validated by nothing.
    //
    // Ratified in clinical v1.15, which also opened the migration window: the
    // shape accepts a name in either spelling through an sh:or so pods already
    // holding health:procedureName triples do not have to be rewritten, and
    // clinical:ProcedureNameSpellingShape warns wherever the old spelling
    // appears. Producers write the canonical spelling only — dual-writing would
    // add a duplicate triple to every new record for no validation benefit,
    // since the sh:or already covers the old pods.
    if (procedureName) quads.push(makeQuad(subj, namedNode(NS.clinical + 'procedureName'), literal(procedureName)));
    // Typed from the raw effectiveTime; see `dates.ts`.
    const performedQuad = ccdaDateQuad(uri, NS.health + 'performedDate', dateVal, warnings);
    if (performedQuad) quads.push(performedQuad);
    if (code) {
      if (codeSystem.includes('6.96') || codeSystem === snomedOid) {
        quads.push(makeQuad(subj, namedNode(NS.health + 'snomedCode'), namedNode(resolveCodeUri(snomedOid, code))));
      } else if (codeSystem.includes('6.12') || codeSystem === cptOid) {
        quads.push(makeQuad(subj, namedNode(NS.health + 'cptCode'), literal(code)));
      }
    }
    if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
  }

  return quads;
}
