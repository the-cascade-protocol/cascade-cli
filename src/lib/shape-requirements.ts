/**
 * The properties a record class MUST carry, read from the bundled SHACL shapes.
 *
 * Same source as `shape-datatypes.ts`, for the same reason: the writer and the validator must
 * never disagree about what a record needs. Only Violation-severity `sh:minCount` constraints
 * on a plain predicate path count. A Warning-level requirement still lets a record through
 * `cascade validate`, so it must not stop a writer either.
 */

import { DataFactory } from 'n3';
import type { Store, Term } from 'n3';
import { loadShapes } from './shacl-validator.js';

const { namedNode } = DataFactory;

const SH = 'http://www.w3.org/ns/shacl#';
const SH_VIOLATION = `${SH}Violation`;

function severityOf(store: Store, node: Term): string | undefined {
  return store.getObjects(node, namedNode(`${SH}severity`), null)[0]?.value;
}

function isDeactivated(store: Store, node: Term): boolean {
  return store.getObjects(node, namedNode(`${SH}deactivated`), null).some((o) => o.value === 'true');
}

const cache = new Map<string, string[]>();

/** Predicate IRIs every record of `classIri` must carry to pass validation, sorted. */
export function requiredProperties(classIri: string): string[] {
  const cached = cache.get(classIri);
  if (cached) return cached;

  const { store } = loadShapes();
  const required = new Set<string>();
  for (const shape of store.getSubjects(namedNode(`${SH}targetClass`), namedNode(classIri), null)) {
    if (isDeactivated(store, shape)) continue;
    const shapeSeverity = severityOf(store, shape);
    for (const prop of store.getObjects(shape, namedNode(`${SH}property`), null)) {
      if (isDeactivated(store, prop)) continue;
      const min = Number(store.getObjects(prop, namedNode(`${SH}minCount`), null)[0]?.value ?? 0);
      if (!(min >= 1)) continue;
      if ((severityOf(store, prop) ?? shapeSeverity ?? SH_VIOLATION) !== SH_VIOLATION) continue;
      const path = store.getObjects(prop, namedNode(`${SH}path`), null)[0];
      if (path?.termType === 'NamedNode') required.add(path.value);
    }
  }

  const out = [...required].sort();
  cache.set(classIri, out);
  return out;
}
