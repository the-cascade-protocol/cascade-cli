/**
 * Every Cascade term this CLI writes is declared by a vocabulary.
 *
 * WHY. A shape that is not closed accepts any predicate, so a converter that
 * writes a misspelled or never-declared term (the wrong namespace, a name no
 * ontology defines) passes `cascade validate` and lands in pods. Nothing
 * downstream can read it by its declared name, and no validation ever says so.
 * This gate makes that class of defect a test failure instead of a silent
 * divergence between the CLI and the vocabularies it claims to write.
 *
 * WHAT COUNTS AS DECLARED. The ontology copies vendored in `src/shapes/*.ttl`
 * (the non-`.shapes.ttl` files). They are the copies the CLI ships and
 * validates against, synced from the spec at the versions in VOCAB_VERSIONS
 * (tests/shapes-sync.test.ts and scripts/check-shapes-drift.mjs keep them
 * honest), so the gate needs no sibling spec checkout and moves only when the
 * pinned vocabulary moves.
 *   - A predicate is declared when some ontology types it owl:DatatypeProperty,
 *     owl:ObjectProperty, owl:AnnotationProperty or rdf:Property.
 *   - An `rdf:type` object is declared when some ontology types it owl:Class
 *     or rdfs:Class. An owl:NamedIndividual or skos:Concept does NOT count: the
 *     vocabularies use those for enumerated VALUES (objects of an ordinary
 *     predicate), and a node typed with a value is a modelling error the gate
 *     should report, not excuse. Such a hit is labelled distinctly.
 *   - The static half cannot tell a predicate from a class, so there a term is
 *     declared when any ontology declares it as a property, class, individual
 *     or concept. (It is kind-blind: a class name written as a predicate, or
 *     an individual written as an rdf:type object, passes it; only the
 *     dynamic half checks the kind.)
 *
 * WHAT IS CHECKED. Every IRI on a host whose name contains "cascade", either
 * scheme, whatever its shape. A hyphenated local name, `http://` for
 * `https://`, or a misspelled namespace path or host can never match a
 * declaration, so it fails unless listed; it is never dropped as "not a
 * term". A host misspelled so that it no longer contains "cascade" is not
 * seen.
 *
 * TWO HALVES.
 *   1. Dynamic. Every registered importer that writes Turtle runs over every
 *      committed fixture it accepts (its own detect() says yes): this repo's
 *      test-fixtures/ and tests/fixtures/, and the sibling conformance
 *      checkout's fixtures/. `pod extract`'s two Turtle builders run over one
 *      entity of every mapped type. Every predicate and every rdf:type object
 *      under https://ns.cascadeprotocol.org/ is collected from the output.
 *      This is exact for the paths it reaches, including IRIs built at run
 *      time, and blind to every path no fixture reaches.
 *   2. Static. The TypeScript AST of every file under src/ is scanned for IRI
 *      construction the fixtures may not reach; see scanSource() for the
 *      idioms, and its header for what the heuristic cannot see.
 *
 * THE BASELINE. tests/fixtures/emitted-terms-baseline.json lists the undeclared
 * terms that predate this gate. It is a gate input, not a filter. The run fails
 * when an undeclared term appears that it does not list, and when a listed
 * entry stops matching what the code does: the term became declared, it is no
 * longer written, or its recorded facts (roles emitted from fixtures, static
 * write-site count, files) changed. So the list can only shrink, one explicit
 * committed edit at a time, and a new writer of an already-listed term fails
 * too. Each entry is a fix to make: declare the term in the spec, or move the
 * writer to the declared term.
 *
 * This is a TEST gate only. Nothing here runs at write time; the CLI never
 * refuses a write because a term is undeclared.
 *
 * Regenerating the baseline (only after deciding that a change to it is
 * right): EMITTED_TERMS_BASELINE=write npx vitest run tests/emitted-terms-declared.test.ts
 * then review and commit the diff. EMITTED_TERMS_DEBUG=1 prints every
 * undeclared term with its write sites.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { Parser } from 'n3';
import type { Quad } from 'n3';

import { importers } from '../src/lib/import-registry.js';
import type { FormatImporter, ImportContext } from '../src/lib/import-types.js';
import {
  ENTITY_TYPE_MAP,
  buildAIExtractedTurtle,
  buildDiscardedTurtle,
} from '../src/commands/pod/extract.js';
import { CONFORMANCE_ROOT, REPO_ROOT } from './helpers/conformance.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL = 'http://www.w3.org/2002/07/owl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';

const PROPERTY_KINDS = new Set([
  OWL + 'DatatypeProperty',
  OWL + 'ObjectProperty',
  OWL + 'AnnotationProperty',
  RDF + 'Property',
]);
const CLASS_KINDS = new Set([OWL + 'Class', RDFS + 'Class']);
const VALUE_KINDS = new Set([OWL + 'NamedIndividual', SKOS + 'Concept']);

/**
 * A well-formed term IRI: namespace plus a local name. It is the only shape a
 * vocabulary declares, and it is used for display and for the namespace
 * tables. It is NOT the filter for what gets checked; see isCascadeCandidate.
 */
const TERM_IRI = /^https:\/\/ns\.cascadeprotocol\.org\/([a-z][a-z0-9-]*)\/v(\d+)#([A-Za-z_][A-Za-z0-9_]*)$/;
const NAMESPACE_IRI = /^https:\/\/ns\.cascadeprotocol\.org\/[a-z][a-z0-9-]*\/v\d+#$/;
/**
 * Any IRI on a host whose name contains "cascade", either scheme. Every
 * predicate and rdf:type object matching this is checked, whatever its shape:
 * a hyphenated local name, `http://` for `https://`, a misspelled namespace
 * path or host. None of those can match a declaration, so each one fails
 * unless listed, instead of being dropped as "not a term".
 */
const CASCADE_HOST_IRI = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*cascade/i;
/** The same, inside literal text, requiring a non-empty `#` fragment (a term, not a page or a namespace). */
const CASCADE_TERM_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^/?#\s"'`<>]*cascade[^\s"'`<>{}|\\^]*#[^\s"'`<>{}|\\^]+/gi;
/** Characters that cannot occur in an IRI; the first one ends it. */
const IRI_END = /[\s<>"'`{}|\\^]/;
/** A Turtle PN_LOCAL, loosely: letters, digits, `_`, `-`, `.` (a trailing `.` is punctuation). */
const PN_LOCAL = '[A-Za-z_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?';

function isCascadeCandidate(iri: string): boolean {
  return CASCADE_HOST_IRI.test(iri) && !NAMESPACE_IRI.test(iri);
}

const SHAPES_DIR = path.join(REPO_ROOT, 'src', 'shapes');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const BASELINE_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'emitted-terms-baseline.json');

/** Fixture trees the dynamic half walks. Every file is offered to every importer. */
const FIXTURE_ROOTS = [
  path.join(REPO_ROOT, 'test-fixtures'),
  path.join(REPO_ROOT, 'tests', 'fixtures'),
  path.join(CONFORMANCE_ROOT, 'fixtures'),
];
/**
 * Directories imported into one scratch pod by the built CLI, in order. The
 * last one is imported a second time with --reconcile-existing so the
 * cross-batch merge and conflict writers run too. `pod import` routes FHIR and
 * C-CDA only, so the genomics fixtures are covered by the converter loop alone.
 */
const POD_IMPORT_SOURCES = [
  path.join(REPO_ROOT, 'test-fixtures'),
  path.join(CONFORMANCE_ROOT, 'fixtures', 'clinical-fhir'),
  path.join(CONFORMANCE_ROOT, 'fixtures', 'ccda'),
];
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'index.js');

const FIXTURE_EXTENSIONS = new Set(['.json', '.ndjson', '.xml', '.zip', '.gz', '.vcf']);
const BINARY_EXTENSIONS = new Set(['.zip', '.gz']);

/** Compact, human-readable name for a term IRI: `cascade:foo`, `clinical:bar`. */
function compact(iri: string): string {
  const m = TERM_IRI.exec(iri);
  if (!m) return iri;
  const [, vocab, version, local] = m;
  if (version !== '1') return iri;
  return `${vocab === 'core' ? 'cascade' : vocab}:${local}`;
}

function rel(p: string): string {
  const fromRepo = path.relative(REPO_ROOT, p);
  if (!fromRepo.startsWith('..')) return fromRepo;
  return 'conformance/' + path.relative(CONFORMANCE_ROOT, p);
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

interface Declarations {
  /** Term IRI -> every rdf:type an ontology gives it. */
  kinds: Map<string, Set<string>>;
  /** Prefix -> namespace, for every ontology prefix inside ns.cascadeprotocol.org. */
  prefixes: Map<string, string>;
  files: string[];
}

function loadDeclarations(): Declarations {
  const kinds = new Map<string, Set<string>>();
  const prefixes = new Map<string, string>();
  const files = fs
    .readdirSync(SHAPES_DIR)
    .filter((f) => f.endsWith('.ttl') && !f.endsWith('.shapes.ttl'))
    .sort();
  for (const f of files) {
    const text = fs.readFileSync(path.join(SHAPES_DIR, f), 'utf-8');
    const quads = new Parser().parse(text, null, (prefix, ns) => {
      const iri = typeof ns === 'string' ? ns : ns.value;
      if (NAMESPACE_IRI.test(iri)) prefixes.set(prefix, iri);
    });
    for (const q of quads) {
      if (q.predicate.value !== RDF_TYPE || q.subject.termType !== 'NamedNode') continue;
      if (!isCascadeCandidate(q.subject.value)) continue;
      let set = kinds.get(q.subject.value);
      if (!set) kinds.set(q.subject.value, (set = new Set()));
      set.add(q.object.value);
    }
  }
  return { kinds, prefixes, files };
}

function hasKind(decl: Declarations, iri: string, allowed: Set<string>): boolean {
  const k = decl.kinds.get(iri);
  return !!k && [...k].some((x) => allowed.has(x));
}

function declaredAsAnything(decl: Declarations, iri: string): boolean {
  return decl.kinds.has(iri);
}

// ---------------------------------------------------------------------------
// Dynamic half
// ---------------------------------------------------------------------------

type Role = 'predicate' | 'type';

interface Emission {
  roles: Set<Role>;
  /** First witness per role, for failure messages. */
  witness: Map<Role, string>;
}

interface DynamicResult {
  emitted: Map<string, Emission>;
  /** importer format -> number of fixtures it converted with non-empty output. */
  conversions: Map<string, number>;
  filesOffered: number;
  filesAccepted: number;
  /** Conversions that threw, as `fixture [format] threw: message`. */
  failures: string[];
}

function record(emitted: Map<string, Emission>, iri: string, role: Role, witness: string): void {
  if (!isCascadeCandidate(iri)) return;
  let e = emitted.get(iri);
  if (!e) emitted.set(iri, (e = { roles: new Set(), witness: new Map() }));
  e.roles.add(role);
  if (!e.witness.has(role)) e.witness.set(role, witness);
}

function collectQuads(emitted: Map<string, Emission>, quads: Quad[], witness: string): void {
  for (const q of quads) {
    record(emitted, q.predicate.value, 'predicate', witness);
    if (q.predicate.value === RDF_TYPE && q.object.termType === 'NamedNode') {
      record(emitted, q.object.value, 'type', witness);
    }
  }
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      // statSync follows symlinks, so a symlinked fixture tree is walked too.
      const st = fs.statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) out.push(full);
    }
  }
  return out.sort();
}

/**
 * Every value-less importer flag (`--allow-vrs-hash-mismatch`, ...) switched
 * on, so the paths those flags open are converted too. Flags that take a value
 * (`--manifest [file]`) only steer sidecar files and are left unset.
 */
function allBooleanFlags(): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const i of importers) {
    for (const o of i.cliOptions ?? []) {
      const m = /^--([a-z0-9-]+)$/.exec(o.flag.trim());
      if (m) options[m[1].replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = true;
    }
  }
  return options;
}

/** Importers whose output is Cascade RDF. The reverse (cascade -> FHIR) one is not. */
function rdfImporters(): FormatImporter[] {
  return importers.filter((i) => i.supportedOutputs.includes('turtle'));
}

async function runDynamic(): Promise<DynamicResult> {
  const emitted = new Map<string, Emission>();
  const conversions = new Map<string, number>();
  const failures: string[] = [];
  let filesOffered = 0;
  let filesAccepted = 0;
  const candidates = FIXTURE_ROOTS.flatMap(walkFiles).filter((f) =>
    FIXTURE_EXTENSIONS.has(path.extname(f).toLowerCase()),
  );

  for (const file of candidates) {
    filesOffered++;
    const ext = path.extname(file).toLowerCase();
    const input: string | Buffer = BINARY_EXTENSIONS.has(ext)
      ? fs.readFileSync(file)
      : fs.readFileSync(file, 'utf-8');
    let accepted = false;
    for (const importer of rdfImporters()) {
      let detected = false;
      try {
        detected = importer.detect(input);
      } catch {
        detected = false;
      }
      if (!detected) continue;
      accepted = true;
      const ctx: ImportContext = {
        inputPath: file,
        outputSerialization: 'turtle',
        // Set so the converters' source-system writers run too.
        sourceSystem: 'emitted-terms-gate',
        passthroughMinimal: false,
        importedAt: '2026-01-01T00:00:00Z',
        options: allBooleanFlags(),
      };
      let result;
      try {
        result = await importer.convert(input, 'turtle', ctx);
      } catch (err) {
        failures.push(`${rel(file)} [${importer.format}] threw: ${(err as Error).message}`);
        continue;
      }
      if (!result.success || !result.output.trim()) {
        // A detector that says yes to a file its converter cannot handle (the
        // C-CDA detector accepts any XML, ClinVar's included) is not this
        // gate's business; the conversion simply contributes nothing.
        continue;
      }
      const quads = new Parser().parse(result.output);
      collectQuads(emitted, quads, `${importer.format} ${rel(file)}`);
      conversions.set(importer.format, (conversions.get(importer.format) ?? 0) + 1);
    }
    if (accepted) filesAccepted++;
  }

  // `pod extract` writes its Turtle by string templates rather than through a
  // converter. Drive both builders with one entity of every mapped type, plus
  // one unmapped type for the fallback.
  const types = [...Object.keys(ENTITY_TYPE_MAP), 'unmapped-entity-type'];
  type Accepted = Parameters<typeof buildAIExtractedTurtle>[0][number];
  type Discarded = Parameters<typeof buildDiscardedTurtle>[0][number];
  const block = {
    subjectUri: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    sectionCode: '11450-4',
    section: 'Problems',
    narrativeText: 'Synthetic narrative for the emitted-terms gate.',
  };
  const accepted: Accepted[] = types.map((type, i) => ({
    block,
    entity: { type, displayName: `Entity ${i}`, confidence: 0.9, sourceText: `source ${i}` },
    result: {
      entities: [],
      confidence: 0.9,
      modelId: 'gate-model',
      latencyMs: 1,
      requiresReview: false,
      schemaVersion: '1',
    },
  }));
  const discarded: Discarded[] = accepted.map(({ block: b, entity }) => ({ block: b, entity }));
  collectQuads(emitted, new Parser().parse(buildAIExtractedTurtle(accepted, '')), 'pod extract (auto-accepted)');
  collectQuads(emitted, new Parser().parse(buildDiscardedTurtle(discarded, '')), 'pod extract (discarded)');
  conversions.set('pod-extract', 2);

  // The pod layer: what `pod init` and `pod import` write around the converter
  // output (index and type-index entries, import provenance, reconciliation,
  // pending conflicts). Runs the built CLI, like the other dist-spawning suites.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'emitted-terms-'));
  try {
    const pod = path.join(scratch, 'pod');
    const cli = (args: string[]): void => {
      execFileSync('node', [CLI_PATH, ...args], { stdio: 'pipe', timeout: 120_000 });
    };
    cli(['pod', 'init', pod]);
    for (const src of POD_IMPORT_SOURCES) cli(['pod', 'import', pod, src]);
    cli(['pod', 'import', pod, POD_IMPORT_SOURCES[POD_IMPORT_SOURCES.length - 1], '--reconcile-existing']);
    let podFiles = 0;
    for (const f of walkFiles(pod).filter((x) => x.endsWith('.ttl'))) {
      collectQuads(emitted, new Parser().parse(fs.readFileSync(f, 'utf-8')), `pod import -> ${path.relative(pod, f)}`);
      podFiles++;
    }
    conversions.set('pod-import', podFiles);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  return { emitted, conversions, filesOffered, filesAccepted, failures };
}

// ---------------------------------------------------------------------------
// Static half
// ---------------------------------------------------------------------------

/**
 * Static scan of src/ for Cascade term IRIs built in code.
 *
 * Idioms recognised (comments are never read; this walks the TypeScript AST):
 *   A. `<ns> + '<local>'`, where `<ns>` resolves to a Cascade namespace string:
 *      a constant (`GENOMICS_NS`), a member of a namespace table (`NS.clinical`,
 *      `CASCADE_NAMESPACES.health`, `NS_ALL.genomics`), or a local alias of
 *      either. The whole `+` chain is folded: string literals after the
 *      namespace are joined up to the first character an IRI cannot hold, so
 *      `NS.x + 'a' + 'b'` is one IRI and `NS.x + 'a' + y` is dynamic. A
 *      parenthesised `cond ? 'A' : 'B'` on the right yields both.
 *   B. Template literals `${<ns>}<local>...`, the local name running to the
 *      first character an IRI cannot hold.
 *   C. A full Cascade-host IRI with a `#` fragment anywhere in string or
 *      template text, any scheme and any shape
 *      (`'https://ns.cascadeprotocol.org/core/v1#mergedFrom'`, `<...>` inside
 *      a Turtle template).
 *   D. A prefixed name (`cascade:foo`) inside a string or template literal
 *      whose text declares that prefix with `@prefix` (a Turtle template), or
 *      a string literal that is exactly one prefixed name (`'clinical:foo'`,
 *      the form the compact-name helpers expand).
 *   E. A Turtle statement built line by line, with its prefix block in a
 *      different literal: text that starts like a predicate-object line
 *      (`    cascade:foo "x" ;`, `; cascade:bar ...`, `<${s}> a cascade:Baz ;`).
 *      Every prefixed name in such a line counts, objects included.
 *
 * Write or read. Each site is classified by walking up from the IRI to the
 * enclosing statement and taking the nearest decisive context:
 *   - read: an operand of ===, !==, ==, != or `in`; a computed index
 *     (`props[iri]`) that is not an assignment target; an argument or receiver of a lookup call (READ_CALLEES:
 *     has, get, getFirst, getProp, includes, equals, getQuads, ...); a
 *     `case` label.
 *   - write: an argument of a quad or triple builder (WRITE_CALLEES: quad,
 *     tripleStr, tripleRef, addQuad, ...); text inside a Turtle template; a
 *     computed index that is assigned to (`obj[iri] = v`, `+=`, `??=`, `++`,
 *     `delete`).
 *   - a site bound to a name takes the classification of that name's uses
 *     inside the scope that declares it (block, loop or file): write if any
 *     use writes, read if every use reads. Bindings are `const X = <iri>`
 *     (also inside an array or object literal), `for (const x of <list>)`,
 *     and a default parameter value.
 *   - anything else counts as a WRITE. Unknown is treated as the more
 *     dangerous case on purpose, so a new idiom errs toward a visible failure.
 *
 * Limits, stated so a green run is not over-read:
 *   - An IRI built inside a helper function from its parameters (`iri(ns,
 *     local)`, a `term('foo')` wrapper) is invisible here; only the dynamic
 *     half sees it, and only on a path a fixture reaches.
 *   - Turtle templates are read with the vocabulary prefix labels (`cascade:`,
 *     `clinical:`, ...) or the labels a template declares itself. A template
 *     that uses another label for a Cascade namespace, declared elsewhere, is
 *     not read.
 *   - Kind-blind, as above: only declared-or-not is checked here.
 *   - Dynamic local names (`NS.clinical + compInfo.type + 'Value'`, `NS.fhir +
 *     resourceType`) cannot be resolved statically. They are counted and
 *     reported, and only the dynamic half checks them.
 *   - A namespace string passed through a function parameter, returned from a
 *     function, or rebuilt from pieces is not resolved.
 *   - Classification is syntactic. An IRI stored in a table and written by a
 *     loop elsewhere reads as "write" (the default), and one handed to a
 *     helper the lists do not know is also "write". A read helper not in
 *     READ_CALLEES therefore produces a false write, which the baseline shows
 *     as an extra write site, and so does `out[iri] = v` into a display
 *     table. That inflates a count; it never hides a writer.
 *   - Scoping is by enclosing block, not full symbol resolution. An exported
 *     binding (`export const X = ...` or `export { X }`) always counts as a
 *     write: its uses in other files are not followed, so local reads cannot
 *     prove it is read-only.
 *   - Prefixed names in plain prose strings (help text, error messages) are
 *     not scanned unless the string is exactly one prefixed name.
 */

const WRITE_CALLEES = new Set([
  'quad',
  'triple',
  'tripleStr',
  'tripleRef',
  'tripleType',
  'tripleDouble',
  'tripleDate',
  'tripleDateTime',
  'tripleTyped',
  'tripleLit',
  'tripleInt',
  'tripleBool',
  'tripleBoolean',
  'ccdaDateQuad',
  'makeQuad',
  'addQuad',
  'addQuads',
]);

const READ_CALLEES = new Set([
  'has',
  'get',
  'getFirst',
  'getProp',
  'getProps',
  'getAll',
  'first',
  'includes',
  'indexOf',
  'equals',
  'startsWith',
  'endsWith',
  'getQuads',
  'getObjects',
  'getSubjects',
  'getPredicates',
  'countQuads',
  'match',
  'readTerm',
  'readValue',
  'readValues',
  // String handling of the IRI itself (splitting off the local name for a
  // message, say) consumes it; it does not write it.
  'split',
  'slice',
  'substring',
  'lastIndexOf',
  'localeCompare',
]);

type Access = 'write' | 'read';

interface StaticSite {
  iri: string;
  file: string;
  line: number;
  access: Access;
  idiom: 'A' | 'B' | 'C' | 'D' | 'E';
}

interface StaticResult {
  sites: StaticSite[];
  /** `<ns> + <non-literal>` and `${ns}${expr}` sites the scan cannot resolve. */
  dynamicSites: string[];
  filesScanned: number;
}

function listSourceFiles(): string[] {
  return walkFiles(SRC_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isSatisfiesExpression(cur)) {
      cur = cur.expression;
    } else {
      return cur;
    }
  }
}

function stringValue(e: ts.Expression): string | undefined {
  const u = unwrap(e);
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.text;
  return undefined;
}

/**
 * Namespace resolution tables, built from const declarations across src/.
 *   scalars: identifier -> namespace IRI
 *   tables:  identifier -> (key -> namespace IRI)
 * A per-file table shadows the global one (identifiers exported from one file
 * and imported by another resolve through the global one).
 */
interface NsTables {
  scalars: Map<string, string>;
  tables: Map<string, Map<string, string>>;
}

function resolveNs(e: ts.Expression, local: NsTables, global: NsTables): string | undefined {
  const u = unwrap(e);
  const direct = stringValue(u);
  if (direct !== undefined) return NAMESPACE_IRI.test(direct) ? direct : undefined;
  if (ts.isIdentifier(u)) return local.scalars.get(u.text) ?? global.scalars.get(u.text);
  if (ts.isPropertyAccessExpression(u) && ts.isIdentifier(u.expression)) {
    const table = local.tables.get(u.expression.text) ?? global.tables.get(u.expression.text);
    return table?.get(u.name.text);
  }
  if (ts.isElementAccessExpression(u) && ts.isIdentifier(u.expression)) {
    const key = stringValue(u.argumentExpression);
    const table = local.tables.get(u.expression.text) ?? global.tables.get(u.expression.text);
    return key !== undefined ? table?.get(key) : undefined;
  }
  return undefined;
}

function collectNsTables(sources: ts.SourceFile[]): { perFile: Map<string, NsTables>; global: NsTables } {
  const perFile = new Map<string, NsTables>();
  const global: NsTables = { scalars: new Map(), tables: new Map() };
  const conflicted = new Set<string>();
  // Declarations are resolved to a fixpoint: NS_ALL spreads NS and names
  // GENOMICS_NS, which live in other files.
  for (let pass = 0; pass < 4; pass++) {
    for (const sf of sources) {
      let local = perFile.get(sf.fileName);
      if (!local) perFile.set(sf.fileName, (local = { scalars: new Map(), tables: new Map() }));
      const tablesForFile = local;
      const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const name = node.name.text;
          const init = unwrap(node.initializer);
          const scalar = resolveNs(init, tablesForFile, global);
          if (scalar) {
            tablesForFile.scalars.set(name, scalar);
            const prev = global.scalars.get(name);
            if (prev !== undefined && prev !== scalar) conflicted.add(name);
            else global.scalars.set(name, scalar);
          } else if (ts.isObjectLiteralExpression(init)) {
            const table = new Map<string, string>();
            for (const prop of init.properties) {
              if (ts.isPropertyAssignment(prop)) {
                const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
                const v = key !== undefined ? resolveNs(prop.initializer, tablesForFile, global) : undefined;
                if (key !== undefined && v) table.set(key, v);
              } else if (ts.isSpreadAssignment(prop) && ts.isIdentifier(prop.expression)) {
                const spread =
                  tablesForFile.tables.get(prop.expression.text) ?? global.tables.get(prop.expression.text);
                for (const [k, v] of spread ?? []) table.set(k, v);
              }
            }
            if (table.size > 0) {
              tablesForFile.tables.set(name, table);
              if (!global.tables.has(name) || global.tables.get(name)!.size <= table.size) {
                global.tables.set(name, table);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  for (const name of conflicted) global.scalars.delete(name);
  return { perFile, global };
}

function calleeName(call: ts.CallExpression | ts.NewExpression): string | undefined {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return undefined;
}

const COMPARISON = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.InKeyword,
]);

type Context = Access | { boundTo: string; scope: ts.Node } | undefined;

/** The block a declaration is visible in: its loop statement, block or file. */
function scopeOf(decl: ts.Node): ts.Node {
  let cur: ts.Node | undefined = decl.parent;
  while (cur) {
    if (
      ts.isBlock(cur) ||
      ts.isSourceFile(cur) ||
      ts.isModuleBlock(cur) ||
      ts.isForOfStatement(cur) ||
      ts.isForInStatement(cur) ||
      ts.isForStatement(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return decl.getSourceFile();
}

/** `for (const x of <child>)`: the loop variable, when there is exactly one. */
function forOfBinding(stmt: ts.ForOfStatement): string | undefined {
  const init = stmt.initializer;
  if (ts.isVariableDeclarationList(init) && init.declarations.length === 1) {
    const name = init.declarations[0].name;
    if (ts.isIdentifier(name)) return name.text;
  }
  return undefined;
}

function isAssignmentTarget(n: ts.Node): boolean {
  let target: ts.Node = n;
  let p = n.parent;
  while (p && ts.isParenthesizedExpression(p)) {
    target = p;
    p = p.parent;
  }
  if (!p) return false;
  if (ts.isBinaryExpression(p) && p.left === target) {
    const k = p.operatorToken.kind;
    return k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
  }
  if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
    return p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken;
  }
  return ts.isDeleteExpression(p);
}

/** True when a variable declaration is exported (`export const X = ...`). */
function isExportedDeclaration(decl: ts.VariableDeclaration): boolean {
  const stmt = decl.parent?.parent;
  return (
    !!stmt &&
    ts.isVariableStatement(stmt) &&
    !!ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/**
 * Walk up from `node` and return the nearest decisive context, or the name of
 * the const it is bound to, or undefined when nothing decides.
 */
function contextOf(node: ts.Node): Context {
  let child: ts.Node = node;
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isBinaryExpression(cur) && COMPARISON.has(cur.operatorToken.kind)) return 'read';
    if (ts.isElementAccessExpression(cur) && cur.argumentExpression === child) {
      // `obj[iri] = v` (and `+=`, `??=`, `++`, `delete`) puts the IRI into a
      // structure; only a plain lookup `obj[iri]` is a read.
      return isAssignmentTarget(cur) ? 'write' : 'read';
    }
    if (ts.isCaseClause(cur) && cur.expression === child) return 'read';
    if (ts.isCallExpression(cur) || ts.isNewExpression(cur)) {
      const name = calleeName(cur);
      if (name && WRITE_CALLEES.has(name)) return 'write';
      if (name && READ_CALLEES.has(name)) return 'read';
      // `set.has(x)` style: the IRI is the receiver of a read method.
    }
    if (ts.isPropertyAccessExpression(cur) && cur.expression === child) {
      if (READ_CALLEES.has(cur.name.text) && cur.parent && ts.isCallExpression(cur.parent)) return 'read';
    }
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
      // An exported binding is used by other files this scan does not
      // follow, so its local uses cannot prove it is only read.
      if (isExportedDeclaration(cur)) return 'write';
      return { boundTo: cur.name.text, scope: scopeOf(cur) };
    }
    if (ts.isParameter(cur) && cur.initializer === child && ts.isIdentifier(cur.name)) {
      // A default parameter value: classify by the parameter's uses in its function.
      return { boundTo: cur.name.text, scope: cur.parent };
    }
    if (ts.isForOfStatement(cur) && cur.expression === child) {
      const name = forOfBinding(cur);
      return name ? { boundTo: name, scope: cur } : undefined;
    }
    if (
      ts.isExpressionStatement(cur) ||
      ts.isReturnStatement(cur) ||
      ts.isFunctionLike(cur) ||
      ts.isSourceFile(cur) ||
      ts.isIfStatement(cur)
    ) {
      return undefined;
    }
    child = cur;
    cur = cur.parent;
  }
  return undefined;
}

/**
 * Classify a binding by its uses inside the scope that declares it. Scoping is
 * by enclosing block, not by full symbol resolution, so a same-named binding
 * in a nested block is counted too (it can only add uses, and an extra use can
 * only make the answer "write" or "unknown", never a wrong "read").
 */
function classifyBinding(scope: ts.Node, name: string, depth: number): Access | undefined {
  if (depth > 4) return undefined;
  let sawWrite = false;
  let sawRead = false;
  let sawUnknown = false;
  const visit = (n: ts.Node): void => {
    // `export { name }` / `export { name as other }`: exported, so written
    // for all this scan can tell.
    if (ts.isExportSpecifier(n) && (n.propertyName ?? n.name).text === name && !n.parent.parent.moduleSpecifier) {
      sawWrite = true;
    }
    if (ts.isIdentifier(n) && n.text === name) {
      const p = n.parent;
      const isDeclName = p && ts.isVariableDeclaration(p) && p.name === n;
      const isImportOrProp =
        p &&
        (ts.isImportSpecifier(p) ||
          ts.isExportSpecifier(p) ||
          (ts.isPropertyAccessExpression(p) && p.name === n) ||
          (ts.isPropertyAssignment(p) && p.name === n));
      if (!isDeclName && !isImportOrProp) {
        const ctx = contextOf(n);
        const access = typeof ctx === 'object' ? classifyBinding(ctx.scope, ctx.boundTo, depth + 1) : ctx;
        if (access === 'write') sawWrite = true;
        else if (access === 'read') sawRead = true;
        else sawUnknown = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  if (sawWrite) return 'write';
  if (sawRead && !sawUnknown) return 'read';
  return undefined;
}

function classify(node: ts.Node, inTurtleTemplate: boolean): Access {
  if (inTurtleTemplate) return 'write';
  const ctx = contextOf(node);
  if (ctx === 'read' || ctx === 'write') return ctx;
  if (ctx && typeof ctx === 'object') return classifyBinding(ctx.scope, ctx.boundTo, 0) ?? 'write';
  return 'write';
}

const PREFIX_DECL = /@prefix\s+([A-Za-z][A-Za-z0-9_-]*)\s*:\s*<(https:\/\/ns\.cascadeprotocol\.org\/[^>]+)>/g;
const EXACT_PREFIXED_NAME = new RegExp(`^([A-Za-z][A-Za-z0-9_-]*):(${PN_LOCAL})$`);
const ANY_PREFIXED_NAME = new RegExp(`(?<![A-Za-z0-9_<#/:-])([A-Za-z][A-Za-z0-9_-]*):(${PN_LOCAL})`, 'g');
/**
 * Starts like a Turtle predicate-object line: an optional `;`, an optional
 * `<s> a`, a prefixed name, then something that can follow a term in Turtle
 * (a literal, an IRI, a list, another prefixed name, a number, a boolean, a
 * terminator, or the end of the literal where a substitution follows). Prose
 * that merely starts with a prefixed name (`genomics:foo not in v1`) fails the
 * last test, since a bare English word cannot follow a term.
 */
const TURTLE_LINE_START =
  /^(?:[;,]\s*)?(?:<[^>]*>\s+(?:a\s+)?)?([A-Za-z][A-Za-z0-9_-]*):[A-Za-z_][A-Za-z0-9_.-]*(?:\s+(?:["<([;.,]|[A-Za-z][A-Za-z0-9_-]*:|[-+]?\d|true\b|false\b)|\s*$)/;

function isTurtleLine(text: string, prefixes: Map<string, string>): boolean {
  const t = text.trim();
  const m = TURTLE_LINE_START.exec(t);
  return !!m && prefixes.has(m[1]) && /\s/.test(t);
}

/** Text of a string or template literal, with each substitution replaced by a space. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => ' ' + s.literal.text).join('');
  }
  return undefined;
}

function isPlus(n: ts.Node | undefined): n is ts.BinaryExpression {
  return !!n && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

/** Operands of a left-associated `+` chain, in source order. */
function flattenPlus(n: ts.Expression): ts.Expression[] {
  return isPlus(n) ? [...flattenPlus(n.left), n.right] : [n];
}

function scanSource(
  sf: ts.SourceFile,
  tables: NsTables,
  global: NsTables,
  prefixes: Map<string, string>,
  out: StaticResult,
): void {
  const file = path.relative(REPO_ROOT, sf.fileName);
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const add = (iri: string, n: ts.Node, idiom: StaticSite['idiom'], turtle = false): void => {
    if (!isCascadeCandidate(iri)) return;
    out.sites.push({ iri, file, line: lineOf(n), access: classify(n, turtle), idiom });
  };

  const visit = (node: ts.Node): void => {
    // A. <ns> + '<local>', folded over the whole `+` chain so that
    // `NS.x + 'a' + 'b'` is one IRI and `NS.x + 'a' + y` is a dynamic one.
    if (isPlus(node) && !(isPlus(node.parent) && (node.parent as ts.BinaryExpression).left === node)) {
      const ops = flattenPlus(node);
      ops.forEach((op, i) => {
        const ns = resolveNs(op, tables, global);
        if (!ns) return;
        const rest = ops.slice(i + 1);
        if (rest.length === 0) return;
        const first = unwrap(rest[0]);
        if (ts.isConditionalExpression(first) && rest.length === 1) {
          const a = stringValue(first.whenTrue);
          const b = stringValue(first.whenFalse);
          if (a !== undefined) add(ns + a, node, 'A');
          if (b !== undefined) add(ns + b, node, 'A');
          if (a === undefined || b === undefined) out.dynamicSites.push(`${file}:${lineOf(node)}`);
          return;
        }
        let local = '';
        let complete = true;
        for (const r of rest) {
          const lit = stringValue(r);
          if (lit === undefined) {
            complete = false;
            break;
          }
          local += lit;
          if (IRI_END.test(local)) break;
        }
        const end = local.search(IRI_END);
        if (end !== -1) add(ns + local.slice(0, end), node, 'A');
        else if (complete && local) add(ns + local, node, 'A');
        else out.dynamicSites.push(`${file}:${lineOf(node)}`);
      });
    }

    // B. `${ns}<local>`
    if (ts.isTemplateExpression(node)) {
      node.templateSpans.forEach((span) => {
        const ns = resolveNs(span.expression, tables, global);
        if (!ns) return;
        // The IRI runs to the first character an IRI cannot hold. When the
        // literal ends first and another substitution follows, the local name
        // is built at run time.
        const text = span.literal.text;
        const end = text.search(IRI_END);
        const isLast = span === node.templateSpans[node.templateSpans.length - 1];
        if (end > 0) add(ns + text.slice(0, end), node, 'B');
        else if (end === -1 && isLast && text) add(ns + text, node, 'B');
        else out.dynamicSites.push(`${file}:${lineOf(node)}`);
      });
    }

    // C and D: term IRIs and prefixed names inside literal text.
    const text = literalText(node);
    if (text !== undefined) {
      const declared = new Map<string, string>();
      for (const m of text.matchAll(PREFIX_DECL)) declared.set(m[1], m[2]);
      const isTurtle = declared.size > 0;
      for (const m of text.matchAll(CASCADE_TERM_IN_TEXT)) add(m[0], node, 'C', isTurtle);
      if (isTurtle) {
        // Prefixed names only after the prefix block, and only for prefixes
        // this very template declares.
        for (const [prefix, ns] of declared) {
          const re = new RegExp(`(?<![A-Za-z0-9_<#/-])${prefix}:(${PN_LOCAL})`, 'g');
          for (const m of text.matchAll(re)) add(ns + m[1], node, 'D', true);
        }
      } else if (isTurtleLine(text, prefixes)) {
        // E. A Turtle statement fragment built line by line
        // (`    cascade:foo "x" ;`, `<${s}> a cascade:Bar ;`), whose prefix
        // block lives in another literal.
        for (const m of text.matchAll(ANY_PREFIXED_NAME)) {
          const ns = prefixes.get(m[1]);
          if (ns) add(ns + m[2], node, 'E', true);
        }
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const m = EXACT_PREFIXED_NAME.exec(node.text);
        const ns = m ? prefixes.get(m[1]) : undefined;
        if (m && ns) add(ns + m[2], node, 'D');
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function runStatic(prefixes: Map<string, string>): StaticResult {
  const files = listSourceFiles();
  const sources = files.map((f) =>
    ts.createSourceFile(f, fs.readFileSync(f, 'utf-8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS),
  );
  const { perFile, global } = collectNsTables(sources);
  const out: StaticResult = { sites: [], dynamicSites: [], filesScanned: files.length };
  for (const sf of sources) scanSource(sf, perFile.get(sf.fileName)!, global, prefixes, out);
  return out;
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

interface BaselineEntry {
  term: string;
  iri: string;
  /**
   * Roles the dynamic half saw the term written in (converters over the
   * fixtures, the `pod extract` builders, the scratch `pod import`).
   */
  emittedAs: Role[];
  /** Static write sites in src/. */
  writeSites: number;
  /** Files holding those write sites. */
  files: string[];
}

interface BaselineFile {
  $comment: string;
  $rule: string;
  entries: BaselineEntry[];
}

const BASELINE_COMMENT =
  'Enumerated pre-existing undeclared Cascade terms, for tests/emitted-terms-declared.test.ts. ' +
  'This file is a GATE INPUT, not a filter: the test still collects every term. It fails when an ' +
  'undeclared term appears that is not listed here, AND when a listed entry stops matching what the ' +
  'code does (the term became declared, is no longer written, or its emitted roles, write-site count or files ' +
  'changed). So the list can only shrink, and shrinking it is an explicit committed edit.';
const BASELINE_RULE =
  'Each entry is a fix to make: declare the term in the spec vocabulary (then sync the ontology copies ' +
  'in src/shapes), or move the writer to the declared term. Never add an entry to make a new term pass.';

function buildFindings(
  decl: Declarations,
  dyn: DynamicResult,
  stat: StaticResult,
): { entries: Map<string, BaselineEntry>; wrongKind: string[] } {
  const entries = new Map<string, BaselineEntry>();
  const wrongKind: string[] = [];
  const entry = (iri: string): BaselineEntry => {
    let e = entries.get(iri);
    if (!e) {
      e = { term: compact(iri), iri, emittedAs: [], writeSites: 0, files: [] };
      entries.set(iri, e);
    }
    return e;
  };

  for (const [iri, em] of dyn.emitted) {
    if (em.roles.has('predicate') && !hasKind(decl, iri, PROPERTY_KINDS)) {
      entry(iri).emittedAs.push('predicate');
      if (declaredAsAnything(decl, iri)) wrongKind.push(`${compact(iri)} is written as a predicate but declared only as ${[...decl.kinds.get(iri)!].map((k) => k.split(/[#/]/).pop()).join(', ')}`);
    }
    if (em.roles.has('type') && !hasKind(decl, iri, CLASS_KINDS)) {
      entry(iri).emittedAs.push('type');
      if (declaredAsAnything(decl, iri)) {
        const k = [...decl.kinds.get(iri)!];
        const label = k.some((x) => VALUE_KINDS.has(x)) ? 'an enumerated value' : 'a non-class';
        wrongKind.push(`${compact(iri)} is written as an rdf:type object but declared only as ${label} (${k.map((x) => x.split(/[#/]/).pop()).join(', ')})`);
      }
    }
  }
  for (const site of stat.sites) {
    if (site.access !== 'write' || declaredAsAnything(decl, site.iri)) continue;
    const e = entry(site.iri);
    e.writeSites++;
    if (!e.files.includes(site.file)) e.files.push(site.file);
  }
  for (const e of entries.values()) {
    e.emittedAs.sort();
    e.files.sort();
  }
  return { entries, wrongKind };
}

function loadBaseline(): BaselineFile {
  if (!fs.existsSync(BASELINE_PATH)) {
    throw new Error(`${path.relative(REPO_ROOT, BASELINE_PATH)} is missing. It is a required gate input.`);
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')) as BaselineFile;
}

function sortEntries(entries: Iterable<BaselineEntry>): BaselineEntry[] {
  return [...entries].sort((a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0));
}

function describeEntry(e: BaselineEntry): string {
  return `${e.term} (emitted as: ${e.emittedAs.join('+') || 'not reached'}; write sites: ${e.writeSites}${e.files.length ? ' in ' + e.files.join(', ') : ''})`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emitted Cascade terms are declared by a vocabulary', () => {
  let decl: Declarations;
  let dyn: DynamicResult;
  let stat: StaticResult;
  let found: Map<string, BaselineEntry>;
  let wrongKind: string[];

  beforeAll(async () => {
    decl = loadDeclarations();
    dyn = await runDynamic();
    stat = runStatic(decl.prefixes);
    ({ entries: found, wrongKind } = buildFindings(decl, dyn, stat));
    if (process.env.EMITTED_TERMS_DEBUG) {
      for (const e of sortEntries(found.values())) {
        const sites = stat.sites.filter((x) => x.iri === e.iri && x.access === 'write').map((x) => `${x.file}:${x.line}`);
        console.log(`DEBUG ${e.term} [${e.emittedAs.join('+')}] ${sites.join(' ')}`);
      }
    }
    if (process.env.EMITTED_TERMS_BASELINE === 'write') {
      const file: BaselineFile = { $comment: BASELINE_COMMENT, $rule: BASELINE_RULE, entries: sortEntries(found.values()) };
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(file, null, 2) + '\n');
    }
  }, 120_000);

  it('reads a non-trivial vocabulary, fixture set and source tree (no vacuous green)', () => {
    // Floors, not exact counts: each guards against a silent collapse of one
    // input (an empty shapes dir, a missing conformance checkout, a walker
    // that found nothing) turning the gate into a pass that checked nothing.
    expect(decl.files.length).toBeGreaterThanOrEqual(8);
    expect(decl.kinds.size).toBeGreaterThan(1000);
    expect(dyn.filesAccepted).toBeGreaterThan(50);
    expect(dyn.emitted.size).toBeGreaterThan(250);
    expect(stat.filesScanned).toBeGreaterThan(100);
    expect(stat.sites.length).toBeGreaterThan(1000);
    // Every importer that writes Cascade RDF converted at least one fixture.
    // One that converts none is not being checked at all.
    const idle = rdfImporters()
      .map((i) => i.format)
      .filter((f) => (dyn.conversions.get(f) ?? 0) === 0);
    expect(idle, `importers with no fixture to convert: ${idle.join(', ')}`).toEqual([]);
    // The scratch pod holds at least the init files plus a dozen record files.
    expect(dyn.conversions.get('pod-import') ?? 0).toBeGreaterThan(15);
    expect(dyn.failures, dyn.failures.join('\n')).toEqual([]);
  });

  it('no undeclared term is written unless the baseline lists it', () => {
    const baseline = new Map(loadBaseline().entries.map((e) => [e.iri, e]));
    const unlisted = sortEntries([...found.values()].filter((e) => !baseline.has(e.iri)));
    const lines = unlisted.map((e) => {
      const em = dyn.emitted.get(e.iri);
      const witness = em ? [...em.witness.entries()].map(([r, w]) => `${r} via ${w}`).join('; ') : '';
      const sites = stat.sites
        .filter((s) => s.iri === e.iri && s.access === 'write')
        .map((s) => `${s.file}:${s.line}`)
        .join(', ');
      return `  ${describeEntry(e)}${witness ? `\n      emitted: ${witness}` : ''}${sites ? `\n      written at: ${sites}` : ''}`;
    });
    expect(
      unlisted.length,
      `${unlisted.length} undeclared Cascade term(s) written, not in the baseline.\n` +
        'Declare each in the spec vocabulary (and sync src/shapes), or write the declared term instead.\n' +
        'Do not add them to the baseline.\n' +
        lines.join('\n'),
    ).toBe(0);
  });

  it('every baseline entry still matches what the code does (the baseline only shrinks)', () => {
    const baseline = loadBaseline().entries;
    const problems: string[] = [];
    for (const b of baseline) {
      const now = found.get(b.iri);
      if (!now) {
        const declared = declaredAsAnything(decl, b.iri);
        problems.push(
          `  ${b.term}: ${declared ? 'is now declared' : 'is no longer written'}. ` +
            `Remove its entry from ${path.relative(REPO_ROOT, BASELINE_PATH)}.`,
        );
        continue;
      }
      const same =
        JSON.stringify(now.emittedAs) === JSON.stringify(b.emittedAs) &&
        now.writeSites === b.writeSites &&
        JSON.stringify(now.files) === JSON.stringify(b.files);
      if (!same) {
        const grew = now.writeSites > b.writeSites || now.emittedAs.length > b.emittedAs.length ||
          now.files.some((f) => !b.files.includes(f));
        problems.push(
          `  ${b.term}: ${grew ? 'has a NEW writer of an undeclared term; write the declared term instead' : 'has fewer writers; shrink the entry'}.\n` +
            `      baseline: ${describeEntry(b)}\n      now:      ${describeEntry(now)}`,
        );
      }
    }
    expect(problems.length, `${problems.length} stale or changed baseline entr(ies):\n${problems.join('\n')}`).toBe(0);
  });

  it('the baseline file is sorted and has one entry per term', () => {
    const entries = loadBaseline().entries;
    const iris = entries.map((e) => e.iri);
    expect(new Set(iris).size).toBe(iris.length);
    expect(iris).toEqual([...iris].sort());
  });

  it('no term is written in a role its vocabulary does not declare it for', () => {
    // Informational in the same way as the baseline: these terms are listed in
    // the baseline too (a wrong-kind declaration does not declare the role).
    // This test only makes the reason legible; it fails when the baseline
    // check fails.
    const unlisted = wrongKind.filter((w) => {
      const term = w.split(' ')[0];
      return !loadBaseline().entries.some((e) => e.term === term);
    });
    expect(unlisted, unlisted.join('\n')).toEqual([]);
    if (wrongKind.length > 0) console.log(`[emitted-terms] declared, but not in the written role:\n  ${wrongKind.join('\n  ')}`);
  });

  it('reports undeclared terms that src/ only reads (a smell, not a failure)', () => {
    const readOnly = new Map<string, string[]>();
    const written = new Set(stat.sites.filter((s) => s.access === 'write').map((s) => s.iri));
    for (const s of stat.sites) {
      if (s.access !== 'read' || written.has(s.iri) || dyn.emitted.has(s.iri)) continue;
      if (declaredAsAnything(decl, s.iri)) continue;
      const list = readOnly.get(s.iri) ?? [];
      list.push(`${s.file}:${s.line}`);
      readOnly.set(s.iri, list);
    }
    const lines = [...readOnly.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([iri, sites]) => `  ${compact(iri)}  (${sites.join(', ')})`);
    console.log(
      `[emitted-terms] ${dyn.filesAccepted}/${dyn.filesOffered} fixture files converted; ` +
        `${dyn.emitted.size} distinct terms emitted; ${stat.sites.length} static IRI sites in ` +
        `${stat.filesScanned} files (${stat.dynamicSites.length} unresolvable dynamic sites); ` +
        `${found.size} undeclared terms written.\n` +
        `[emitted-terms] conversions per importer: ${[...dyn.conversions.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}\n` +
        `[emitted-terms] undeclared terms read but never written (${readOnly.size}):\n${lines.join('\n') || '  none'}`,
    );
    expect(readOnly.size).toBeGreaterThanOrEqual(0);
  });

  it('the dynamic collector keeps every Cascade-host IRI, term-shaped or not', () => {
    const ttl = [
      '<urn:s> <https://ns.cascadeprotocol.org/core/v1#gate-hyphen> "x" ;',
      '  <http://ns.cascadeprotocol.org/core/v1#plantedHttp> "x" ;',
      '  <https://ns.cascadeprotocl.org/core/v1#plantedHostTypo> "x" ;',
      '  <https://ns.cascadeprotocol.org/cor/v1#plantedPathTypo> "x" ;',
      '  a <https://ns.cascadeprotocol.org/core/v1#Planted-Class> ;',
      '  <http://example.org/notCascade> "x" .',
    ].join('\n');
    const emitted = new Map<string, Emission>();
    collectQuads(emitted, new Parser().parse(ttl), 'planted');
    expect([...emitted.keys()].sort()).toEqual([
      'http://ns.cascadeprotocol.org/core/v1#plantedHttp',
      'https://ns.cascadeprotocl.org/core/v1#plantedHostTypo',
      'https://ns.cascadeprotocol.org/cor/v1#plantedPathTypo',
      'https://ns.cascadeprotocol.org/core/v1#Planted-Class',
      'https://ns.cascadeprotocol.org/core/v1#gate-hyphen',
    ]);
    // None of them can match a declaration, so each would fail unless listed.
    for (const iri of emitted.keys()) expect(declaredAsAnything(decl, iri)).toBe(false);
  });

  it('the static scanner recognises each idiom and classifies write versus read', () => {
    // Pins the heuristic itself, so a regression in the scanner cannot turn
    // the static half into a silent pass.
    const src = [
      "const NS = { clinical: 'https://ns.cascadeprotocol.org/clinical/v1#' } as const;",
      "const G_NS = 'https://ns.cascadeprotocol.org/genomics/v1#';",
      "quads.push(tripleStr(s, NS.clinical + 'plantedA', v));",
      "quads.push(quad(namedNode(s), namedNode(`${G_NS}plantedB`), o));",
      "if (q.predicate.value === NS.clinical + 'plantedC') {}",
      "const x = props.get(NS.clinical + 'plantedD');",
      "const LOOKUP = new Set([NS.clinical + 'plantedE']);",
      'if (LOOKUP.has(p)) {}',
      "const TTL = `@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .\\n<a> clinical:plantedF 1 .`;",
      "const FULL = 'https://ns.cascadeprotocol.org/clinical/v1#plantedG';",
      "quads.push(tripleRef(s, FULL, o));",
      "quads.push(tripleType(s, NS.clinical + (flag ? 'PlantedH' : 'PlantedI')));",
      "quads.push(tripleStr(s, NS.clinical + kind + 'Value', v));",
      "for (const p of [NS.clinical + 'plantedJ']) { if (props[p]) {} }",
      "function show(props) { const KEYS = ['clinical:plantedK']; for (const k of KEYS) { out[k] = props[k]; } }",
      "const PREDS = { a: 'clinical:plantedL' };",
      "lines.push(`<${s}> a clinical:PlantedM ;`); lines.push(`    clinical:plantedN \"${v}\" .`);",
      "warn(`no clinical:plantedO here, just prose`);",
      "gap('clinical:plantedP not in v1; preserved as unmapped.');",
      // Non-term-shaped and near-miss IRIs are checked, never dropped.
      "quads.push(tripleStr(s, NS.clinical + 'planted-hyphen', v));",
      "const BAD = 'http://ns.cascadeprotocol.org/clinical/v1#plantedHttp'; quads.push(tripleRef(s, BAD, o));",
      "const T2 = `@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .\\n<a> clinical:planted-turtle 1 .`;",
      "lines.push('<' + NS.clinical + 'plantedAngle> .');",
      "quads.push(tripleStr(s, NS.clinical + 'plantedChain' + 'Tail', v));",
      // An element-access assignment target is a write; a plain lookup is a read.
      "gateObj[NS.clinical + 'plantedIdxWrite'] = 'x';",
      "gateObj[NS.clinical + 'plantedIdxCompound'] ??= 'x';",
      "const got = gateObj[NS.clinical + 'plantedIdxRead'];",
      // An exported binding is a write whatever its local uses; a local one is not.
      "export const PLANTED_EXPORTED = NS.clinical + 'plantedExported'; if (p === PLANTED_EXPORTED) {}",
      "const PLANTED_ALIASED = NS.clinical + 'plantedAliased'; if (p === PLANTED_ALIASED) {} export { PLANTED_ALIASED };",
      "const PLANTED_LOCAL = NS.clinical + 'plantedLocal'; if (p === PLANTED_LOCAL) {}",
    ].join('\n');
    const sf = ts.createSourceFile(path.join(SRC_DIR, 'planted.ts'), src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const { perFile, global } = collectNsTables([sf]);
    const out: StaticResult = { sites: [], dynamicSites: [], filesScanned: 1 };
    const prefixes = new Map([['clinical', 'https://ns.cascadeprotocol.org/clinical/v1#']]);
    scanSource(sf, perFile.get(sf.fileName)!, global, prefixes, out);
    const got = Object.fromEntries(out.sites.map((s) => [compact(s.iri), s.access]));
    expect(got).toEqual({
      'clinical:plantedA': 'write',
      'genomics:plantedB': 'write',
      'clinical:plantedC': 'read',
      'clinical:plantedD': 'read',
      'clinical:plantedE': 'read',
      'clinical:plantedF': 'write',
      'clinical:plantedG': 'write',
      'clinical:PlantedH': 'write',
      'clinical:PlantedI': 'write',
      'clinical:plantedJ': 'read',
      // `out[k] = props[k]` puts k into a structure: a write by rule, even
      // though here it is a display table. The conservative direction.
      'clinical:plantedK': 'write',
      // Unknown use (an exported table): counted as a write on purpose.
      'clinical:plantedL': 'write',
      'clinical:PlantedM': 'write',
      'clinical:plantedN': 'write',
      'https://ns.cascadeprotocol.org/clinical/v1#planted-hyphen': 'write',
      'http://ns.cascadeprotocol.org/clinical/v1#plantedHttp': 'write',
      'https://ns.cascadeprotocol.org/clinical/v1#planted-turtle': 'write',
      'clinical:plantedAngle': 'write',
      'clinical:plantedChainTail': 'write',
      'clinical:plantedIdxWrite': 'write',
      'clinical:plantedIdxCompound': 'write',
      'clinical:plantedIdxRead': 'read',
      'clinical:plantedExported': 'write',
      'clinical:plantedAliased': 'write',
      'clinical:plantedLocal': 'read',
    });
    expect(out.dynamicSites).toHaveLength(1);
  });
});
