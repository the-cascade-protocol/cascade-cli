/**
 * Cascade Advisory Patch (CAP) — AST types.
 *
 * CAP is a strict profile of W3C LDPatch (2015 Recommendation). It admits:
 *   - `@prefix` declarations from a published vocabulary whitelist (C3)
 *   - An envelope of metadata triples about `<>` (the patch document itself, C6)
 *   - Zero or one `Bind` clause matching against a single stable identifier (C2)
 *   - One or more `Add { ... } .` operations (C1)
 *
 * Out-of-profile constructs (`Delete`, `Cut`, `UpdateList`, additional `Bind`s,
 * unconstrained Bind path expressions, IRI computation) MUST be rejected by the
 * parser before the AST is produced — partial parsing is not a goal.
 *
 * The AST is JSON-serializable: every node is a plain data record with no
 * functions, no class instances, and no circular references. It can be
 * `JSON.stringify`'d as-is for inclusion in dry-run reports.
 *
 * Position info is recorded as 1-based `line` and 1-based `col`, matching the
 * convention most editors use for human debugging.
 */

/** A 1-based source position. */
export interface CapPosition {
  line: number;
  col: number;
}

/** A node with attached position info. */
export interface CapPositioned {
  pos: CapPosition;
}

/**
 * An RDF term as it appears in a CAP file.
 *
 * Discriminated by `kind`:
 *   - `iri`      — a full IRI ("expanded" — prefixes are resolved during parse)
 *   - `literal`  — a string literal, optionally with `datatype` or `lang`
 *   - `variable` — a `?var` reference (only legal as Bind target or in Adds)
 *   - `bnode`    — a blank node (`_:b1`)
 */
export type CapTerm =
  | { kind: 'iri'; value: string; pos?: CapPosition }
  | { kind: 'literal'; value: string; datatype?: string; lang?: string; pos?: CapPosition }
  | { kind: 'variable'; value: string; pos?: CapPosition }
  | { kind: 'bnode'; value: string; pos?: CapPosition };

/** A single triple, with position info on the subject for error reporting. */
export interface CapTriple {
  subject: CapTerm;
  predicate: string; // always an expanded IRI
  object: CapTerm;
  pos: CapPosition;
}

/**
 * A CAP `Bind` clause.
 *
 * Per C2, the path expression is restricted to `?var <predicate> <literal>`,
 * so we model it as exactly one binding triple where `subject` is the bound
 * variable, `predicate` is a whitelisted IRI, and `object` is a literal.
 *
 * Note: the W3C LDPatch grammar permits Bind to also accept an optional
 * fallback IRI for the binding namespace (e.g. `Bind ?v <https://example.org/binding>`
 * before the path). CAP examples in `drafts/advisory-v1/` use this form. We
 * preserve it as `bindingNamespace` for round-tripping but it has no semantic
 * effect under CAP — the validator does not constrain it.
 */
export interface CapBind {
  variable: string;
  bindingNamespace?: string;
  subject: CapTerm;
  predicate: string;
  object: CapTerm;
  pos: CapPosition;
}

/** A CAP `Add { ... } .` operation. */
export interface CapAdd {
  triples: ReadonlyArray<CapTriple>;
  pos: CapPosition;
}

/**
 * The mandatory CAP envelope (C6).
 *
 * In the CAP examples the envelope is expressed as bare Turtle predicate-object
 * pairs on `<>` (the document IRI), preceding any `Bind` or `Add`. The parser
 * collects these and surfaces the well-known fields directly; unknown fields
 * are preserved verbatim under `extra` so downstream tooling can inspect them.
 *
 * All fields except `extra` are optional at the AST level — the *validator*
 * (TASK-4.2) enforces which are required by C6. This keeps parser and
 * validator concerns separate.
 */
export interface CapEnvelope {
  /** Position of the envelope start (the `<>` subject), if present. */
  pos?: CapPosition;
  /** rdf:type predicates — should include `advisory:CascadeAdvisoryPatch`. */
  types: ReadonlyArray<string>;
  profileVersion?: string;
  advisoryClass?: string;
  issuer?: string;
  issuerName?: string;
  issuedAt?: string;
  advisoryId?: string;
  supersedes?: string;
  humanSummary?: string;
  applicableUntil?: string;
  evidenceUrl?: string;
  /** Predicates not explicitly modeled. Predicate IRI -> object term. */
  extra: ReadonlyArray<{ predicate: string; object: CapTerm; pos: CapPosition }>;
}

/** The complete parsed CAP AST. */
export interface CapAst {
  /** Prefix declarations as a plain object (JSON-friendly). prefix -> IRI. */
  prefixes: Readonly<Record<string, string>>;
  envelope: CapEnvelope;
  /** Zero or one Bind. C2 enforces "at most one". */
  bind: CapBind | null;
  /** One or more Add operations. C1 requires at least one. */
  adds: ReadonlyArray<CapAdd>;
}

/** A parser-level error (syntax or out-of-profile construct). */
export interface CapParseError {
  line: number;
  col: number;
  message: string;
  /** Optional code for programmatic handling. */
  code?:
    | 'syntax'
    | 'out_of_profile'
    | 'unknown_prefix'
    | 'invalid_envelope'
    | 'invalid_bind'
    | 'invalid_add';
}

/** A profile-validation violation (TASK-4.2). */
export interface CapViolation {
  /** CAP profile constraint code (PROFILE.md §Constraints). */
  code: 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6';
  message: string;
  location?: CapPosition;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Whitelists                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/** Cascade Protocol vocabulary IRIs (PROFILE.md §C3). */
export const CASCADE_VOCAB_IRIS: ReadonlyArray<string> = [
  'https://ns.cascadeprotocol.org/core/v1#',
  'https://ns.cascadeprotocol.org/health/v1#',
  'https://ns.cascadeprotocol.org/clinical/v1#',
  'https://ns.cascadeprotocol.org/genomics/v1#',
  'https://ns.cascadeprotocol.org/pgx/v1#',
  'https://ns.cascadeprotocol.org/advisory/v1#',
  'https://ns.cascadeprotocol.org/checkup/v1#',
  'https://ns.cascadeprotocol.org/coverage/v1#',
  'https://ns.cascadeprotocol.org/pots/v1#',
];

/** W3C standard prefixes allowed in CAP files (PROFILE.md §C3). */
export const W3C_VOCAB_IRIS: ReadonlyArray<string> = [
  'http://www.w3.org/ns/prov#',
  'http://www.w3.org/2001/XMLSchema#',
  'http://www.w3.org/2000/01/rdf-schema#',
  'http://www.w3.org/2002/07/owl#',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://www.w3.org/ns/ldp#',
];

/** Canonical genomics-standard prefixes allowed in CAP files (PROFILE.md §C3). */
export const GENOMICS_STANDARD_IRIS: ReadonlyArray<string> = [
  'http://purl.obolibrary.org/obo/HP_',
  'http://purl.obolibrary.org/obo/MONDO_',
  'http://purl.obolibrary.org/obo/SO_',
  'https://www.ncbi.nlm.nih.gov/clinvar/',
  'https://www.omim.org/entry/',
  'https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/',
  // Permissive variants (some CAP files use base namespaces):
  'http://purl.obolibrary.org/obo/',
];

/**
 * Whitelisted Bind predicates (PROFILE.md §C2).
 *
 * Stored as fully expanded IRIs to match what the parser produces after prefix
 * resolution.
 */
export const C2_WHITELISTED_BIND_PREDICATES: ReadonlyArray<string> = [
  'https://ns.cascadeprotocol.org/genomics/v1#caId',
  'https://ns.cascadeprotocol.org/genomics/v1#vrsId',
  'https://ns.cascadeprotocol.org/genomics/v1#clinvarVariationId',
  'https://ns.cascadeprotocol.org/genomics/v1#hgncId',
  'https://ns.cascadeprotocol.org/clinical/v1#loincCode',
  'https://ns.cascadeprotocol.org/clinical/v1#rxNormCode',
  'https://ns.cascadeprotocol.org/clinical/v1#icd10Code',
  'https://ns.cascadeprotocol.org/clinical/v1#snomedCode',
];

/** Maximum total inserted triples per CAP advisory match (PROFILE.md §C5). */
export const C5_MAX_INSERTED_TRIPLES = 64;

/** Advisory namespace IRI. */
export const ADVISORY_NS = 'https://ns.cascadeprotocol.org/advisory/v1#';
