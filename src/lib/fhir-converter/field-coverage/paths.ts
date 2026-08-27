/**
 * Element-path navigation for the FHIR field-coverage chokepoint.
 *
 * A "path" here is one populated element of a FHIR resource, written the way the
 * FHIR spec writes element paths, with array indices made explicit:
 *
 *   Encounter.status
 *   Encounter.class.display
 *   Encounter.type[1]
 *   Encounter.participant[0].individual
 *
 * WHY PATHS AND DELETION RATHER THAN A READ-LIST
 * ----------------------------------------------
 * The obvious way to ask "does the converter keep this field?" is to read the
 * converter: collect every `resource.<field>` it mentions. That was tried and it
 * was wrong in both directions. Reading a field is not emitting it —
 * `convertEncounter` reads `resource.identifier` to mint identity and never
 * writes it as a fact, so a read-list calls it kept while the pod contains none.
 * Matching source VALUES against the whole pod is wrong in the other direction:
 * an unrelated record containing the same string reports a false hit.
 *
 * The only question that answers itself is the differential one: convert the
 * resource, convert it again with exactly one element deleted, and compare the
 * output. This module owns the two halves of that experiment that are not about
 * RDF: which elements to try, and how to remove one.
 *
 * ENUMERATION IS LAZY, AND THAT IS THE POINT
 * ------------------------------------------
 * Paths are handed out one level at a time ({@link topLevelFieldPaths}, then
 * {@link childFieldPaths}) rather than as one flat list, so the analysis can
 * STOP DESCENDING at a path it has already proven is dropped. Enumerating
 * `identifier`, `identifier[0]`, `identifier[0].system` and
 * `identifier[0].value` as four separate drops describes one omission four
 * times, and a manifest full of that is a manifest nobody reads.
 *
 * Pruning is sound rather than merely tidy: if any descendant of an element
 * reached the output, deleting the element would have removed that descendant
 * too and the parent would have measured as EMITTED. A dropped parent therefore
 * guarantees dropped descendants.
 *
 * DEPTH IS BOUNDED ON PURPOSE
 * ---------------------------
 * Descent goes two NAMED steps below the resource root (array indices do not
 * count as steps), which is what the measured loss classes need: whole fields
 * (`Encounter.reasonCode`), one level of qualifier (`Encounter.class.display`),
 * array tails (`Encounter.type[1]`), and per-element qualifiers
 * (`Encounter.participant[0].type`). Deeper elements are covered transitively:
 * an emitted `content[0].attachment` carries its own `url`.
 */

/** How many NAMED key steps below the resource root to descend. */
export const MAX_KEY_DEPTH = 2;

/**
 * Elements never enumerated. `resourceType` is the dispatch key: deleting it
 * does not test a field, it tests what happens when the converter is handed
 * something that is not a resource.
 */
const NEVER_ENUMERATED = new Set(['resourceType']);

/** Whether a value counts as populated, i.e. whether the source actually said it. */
export function isPopulated(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface PathSegment {
  key?: string;
  index?: number;
}

/**
 * Split `Encounter.participant[0].type` into its navigable segments, dropping
 * the leading resource type. Returns `undefined` for a path that is not written
 * in this grammar, so a hand-edited manifest entry with a typo is a reported
 * error rather than a silently unmatched rule.
 */
export function parseFieldPath(path: string): PathSegment[] | undefined {
  const firstDot = path.indexOf('.');
  if (firstDot < 0) return undefined;
  const rest = path.slice(firstDot + 1);
  const segments: PathSegment[] = [];
  const token = /([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/y;
  let cursor = 0;
  while (cursor < rest.length) {
    if (rest[cursor] === '.') {
      cursor++;
      continue;
    }
    token.lastIndex = cursor;
    const match = token.exec(rest);
    if (!match) return undefined;
    if (match[1] !== undefined) segments.push({ key: match[1] });
    else segments.push({ index: Number(match[2]) });
    cursor = token.lastIndex;
  }
  return segments.length > 0 ? segments : undefined;
}

/** How many NAMED steps a path takes below the resource root. */
export function namedDepth(path: string): number {
  const segments = parseFieldPath(path);
  if (!segments) return Number.POSITIVE_INFINITY;
  return segments.filter((s) => s.key !== undefined).length;
}

/** The value a path points at, or `undefined` if it does not resolve. */
export function valueAtPath(resource: unknown, path: string): unknown {
  const segments = parseFieldPath(path);
  if (!segments) return undefined;
  let cursor: unknown = resource;
  for (const seg of segments) {
    if (seg.key !== undefined) {
      if (!isPlainObject(cursor)) return undefined;
      cursor = cursor[seg.key];
    } else {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[seg.index!];
    }
    if (cursor === undefined || cursor === null) return undefined;
  }
  return cursor;
}

/** The resource's own type, used as the root of every path it produces. */
export function pathRoot(resource: unknown): string {
  return isPlainObject(resource) && typeof resource.resourceType === 'string'
    ? resource.resourceType
    : 'Resource';
}

/** Every populated top-level element of a resource, in document order. */
export function topLevelFieldPaths(resource: unknown): string[] {
  if (!isPlainObject(resource)) return [];
  const root = pathRoot(resource);
  const paths: string[] = [];
  for (const [key, value] of Object.entries(resource)) {
    if (NEVER_ENUMERATED.has(key)) continue;
    if (!isPopulated(value)) continue;
    paths.push(`${root}.${key}`);
  }
  return paths;
}

/**
 * The populated elements one level below `path`, or an empty list at the depth
 * bound. Array indices and object keys are both one level; only object keys
 * count against the bound.
 */
export function childFieldPaths(resource: unknown, path: string): string[] {
  if (namedDepth(path) >= MAX_KEY_DEPTH) return [];
  const value = valueAtPath(resource, path);
  if (Array.isArray(value)) {
    const paths: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (isPopulated(value[i])) paths.push(`${path}[${i}]`);
    }
    return paths;
  }
  if (isPlainObject(value)) {
    const paths: string[] = [];
    for (const [key, child] of Object.entries(value)) {
      if (isPopulated(child)) paths.push(`${path}.${key}`);
    }
    return paths;
  }
  return [];
}

/**
 * Every populated path a full walk would visit, WITHOUT pruning.
 *
 * Only for the degenerate case where a resource cannot be converted at all and
 * every path is therefore untestable. The analysis proper walks lazily.
 */
export function enumerateFieldPaths(resource: unknown): string[] {
  const out: string[] = [];
  const visit = (path: string): void => {
    out.push(path);
    for (const child of childFieldPaths(resource, path)) visit(child);
  };
  for (const path of topLevelFieldPaths(resource)) visit(path);
  return out;
}

/**
 * A deep copy of `resource` with exactly one element removed.
 *
 * A named element is deleted; an array element is SPLICED OUT rather than set to
 * `undefined`, because a hole in an array is not a shape any FHIR server emits
 * and a converter reading `type[1]` of a two-element array with a hole would be
 * answering a question nobody asked.
 *
 * Returns `undefined` when the path does not resolve, which the callers treat as
 * an error rather than as "no difference": a path that cannot be deleted cannot
 * be tested, and reporting it as unchanged would mark a live field as dropped.
 */
export function withoutPath<T>(resource: T, path: string): T | undefined {
  const segments = parseFieldPath(path);
  if (!segments) return undefined;
  const copy = structuredClone(resource) as unknown;

  let cursor: unknown = copy;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (seg.key !== undefined) {
      if (!isPlainObject(cursor)) return undefined;
      cursor = cursor[seg.key];
    } else {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[seg.index!];
    }
    if (cursor === undefined || cursor === null) return undefined;
  }

  const last = segments[segments.length - 1];
  if (last.key !== undefined) {
    if (!isPlainObject(cursor) || !(last.key in cursor)) return undefined;
    delete cursor[last.key];
  } else {
    if (!Array.isArray(cursor) || last.index! >= cursor.length) return undefined;
    cursor.splice(last.index!, 1);
  }
  return copy as T;
}
