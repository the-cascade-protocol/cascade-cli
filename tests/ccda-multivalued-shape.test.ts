/**
 * A C-CDA element that may repeat has ONE shape, and this is the lock on the
 * two ways it used to get a second one.
 *
 * WHAT IS BEING PROTECTED, STATED SO THE NEXT READER DOES NOT HAVE TO GUESS
 * ------------------------------------------------------------------------
 * The CDA R2.1 schema declares many elements 0..*. `fast-xml-parser` gives such
 * an element an ARRAY when it is forced to and a plain OBJECT otherwise, and the
 * forcing used to be decided in two places that could disagree:
 *
 *   - the XML parser's `isArray` predicate (13 element names, every document);
 *   - each vendor quirk module's own SHOULD_BE_ARRAY list (a DIFFERENT set,
 *     applied only to documents whose custodian matched that vendor).
 *
 * `organizer` and `supply` were in the vendor lists and not the parser's. So
 * `entry.organizer` was an object on most documents and an array on documents
 * from a recognized vendor, and four handlers dereferenced it as an object:
 * labs, vital signs, family history and implanted devices. On a recognized
 * vendor's export all four produced ZERO records — no error, no warning, no skip
 * count. The corpus never caught it because no corpus fixture is classified as a
 * vendor at all, so the vendor-normalized shape was the one shape never tested.
 *
 * This is the third time one idea has shipped: `act.entryRelationship` read as
 * an object, `organizer.component[].observation` read as an object, and now
 * `entry.organizer` itself. Every instance is a container that is an array in
 * real pipeline output and an object in every hand-built fixture. So the fix is
 * not three unwraps.
 *
 * THE THREE RULES
 * ---------------
 *   1. ONE LIST. `CCDA_MULTIVALUED_ELEMENTS` in `lib/ccda-converter/multivalued.ts`
 *      is the only list of repeatable element names, and no other module may
 *      declare one. Two lists is the defect.
 *   2. THE SHAPE DOES NOT DEPEND ON THE VENDOR. `applyVendorNormalization` must
 *      return a document deep-equal to its input for every vendor and every
 *      fixture. If a vendor shim ever changes a shape behind a handler's back
 *      again, this fails.
 *   3. NO HANDLER DEREFERENCES A REPEATABLE CONTAINER. Nothing under
 *      `lib/ccda-converter/` may write `.organizer.x`, `.organizer?.x`,
 *      `.organizer[0]` or `.organizer['x']`. Unwrap with `firstOf()`/`listOf()`
 *      first. This is the rule that stops occurrence four.
 *
 * WHAT THESE WOULD DO IF THE FIX WERE ABSENT — measured against 0f33c78:
 *   Rule 1 FAILS (three separate lists: parser.ts, quirks/epic.ts, quirks/cerner.ts).
 *   Rule 2 FAILS (`organizer` object -> array on every fixture with an organizer).
 *   Rule 3 FAILS (7 sites, including the four zero-record ones).
 * Every one of them is green here.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCcdaXml } from '../src/lib/ccda-converter/parser.js';
import { applyVendorNormalization } from '../src/lib/ccda-converter/vendor/normalize.js';
import {
  CCDA_MULTIVALUED_ELEMENTS,
  firstOf,
  listOf,
  canonicalizeMultivaluedElements,
} from '../src/lib/ccda-converter/multivalued.js';
import { SYNTHETIC_EPIC_CCDA, SYNTHETIC_UNKNOWN_VENDOR_CCDA } from './ccda-synthetic-documents.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, '..', 'src');
const CCDA_DIR = path.join(SRC_DIR, 'lib', 'ccda-converter');
/** The one module allowed to name these elements and to unwrap them. */
const LIST_OWNER = 'lib/ccda-converter/multivalued.ts';
const CORPUS = path.resolve(HERE, '..', '..', 'conformance', 'fixtures', 'ccda');

function ccdaSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.ts')) {
        out.push(path.relative(SRC_DIR, full).split(path.sep).join('/'));
      }
    }
  };
  walk(CCDA_DIR);
  return out.sort();
}

/** Strip line and block comments so prose about the rule does not break it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const FILES = ccdaSourceFiles();
const CODE = new Map(FILES.map((f) => [f, fs.readFileSync(path.join(SRC_DIR, f), 'utf8')]));
const CORPUS_FILES = fs.existsSync(CORPUS)
  ? fs.readdirSync(CORPUS).filter((f) => f.endsWith('.xml')).sort()
  : [];

// The suite reads sibling checkouts. An empty corpus is a broken checkout, not a
// reason to quietly test less — say so rather than skip.
if (CORPUS_FILES.length === 0) {
  throw new Error(
    `No C-CDA fixtures found at ${CORPUS}. The sibling \`conformance\` checkout must be ` +
      `resolvable from the repo's parent directory; this test does not skip.`,
  );
}

// ---------------------------------------------------------------------------
// Rule 1 — one list
// ---------------------------------------------------------------------------

describe('C-CDA repeatable elements are declared in exactly one place', () => {
  it('no module besides the list owner declares its own array-element list', () => {
    // A second list is the defect itself: the parser and two vendor shims each
    // kept one, and they disagreed about `organizer` and `supply`.
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file === LIST_OWNER) continue;
      const code = stripComments(CODE.get(file)!);
      if (/SHOULD_BE_ARRAY/.test(code)) offenders.push(`${file}: declares SHOULD_BE_ARRAY`);
      // A literal array of element-name strings that overlaps the canonical list
      // by three or more names is a second list under another name.
      for (const m of code.matchAll(/\[\s*((?:'[^']*'\s*,\s*){2,}'[^']*'\s*,?)\s*\]/g)) {
        const names = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
        const overlap = names.filter((n) => (CCDA_MULTIVALUED_ELEMENTS as readonly string[]).includes(n));
        if (overlap.length >= 3) {
          offenders.push(`${file}: array literal re-declares ${overlap.join(', ')}`);
        }
      }
    }
    expect(
      offenders,
      `Import CCDA_MULTIVALUED_ELEMENTS from ${LIST_OWNER}. A second list is exactly how ` +
        `\`organizer\` came to be an array on some documents and an object on others.`,
    ).toEqual([]);
  });

  it('the parser forces every name on the canonical list, and nothing else', () => {
    // Proved through the parser rather than by reading its source: build a
    // document containing each element once, and check what comes back.
    for (const name of CCDA_MULTIVALUED_ELEMENTS) {
      const parsed = parseCcdaXml(`<Probe><${name}>x</${name}></Probe>`);
      expect(Array.isArray(parsed.Probe[name]), `<${name}> must parse as an array`).toBe(true);
    }
    // A name NOT on the list must stay scalar, or the list is not the authority.
    const other = parseCcdaXml('<Probe><statusCode>x</statusCode></Probe>');
    expect(Array.isArray(other.Probe.statusCode)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — the shape does not depend on the vendor
// ---------------------------------------------------------------------------

describe('vendor normalization cannot change a document shape', () => {
  const vendors = ['epic', 'cerner', 'athena', 'unknown'] as const;

  for (const file of CORPUS_FILES) {
    for (const vendor of vendors) {
      it(`${file}: applyVendorNormalization(…, '${vendor}') returns the parsed shape unchanged`, () => {
        const parsed = parseCcdaXml(fs.readFileSync(path.join(CORPUS, file), 'utf8'));
        const normalized = applyVendorNormalization(parsed, vendor);
        // Deep-equal, not identity: the normalizer legitimately clones.
        expect(normalized).toEqual(parsed);
        expect(normalized).not.toBe(parsed);
      });
    }
  }

  for (const [label, xml] of [
    ['synthetic Epic-detected document', SYNTHETIC_EPIC_CCDA],
    ['synthetic unknown-vendor document', SYNTHETIC_UNKNOWN_VENDOR_CCDA],
  ] as const) {
    for (const vendor of vendors) {
      it(`${label}: applyVendorNormalization(…, '${vendor}') returns the parsed shape unchanged`, () => {
        const parsed = parseCcdaXml(xml);
        expect(applyVendorNormalization(parsed, vendor)).toEqual(parsed);
      });
    }
  }

  it('the two synthetic documents differ ONLY in their custodian, so the vendor is the variable', () => {
    // Otherwise "same records from both" would prove nothing about the vendor.
    const epic = parseCcdaXml(SYNTHETIC_EPIC_CCDA);
    const unknown = parseCcdaXml(SYNTHETIC_UNKNOWN_VENDOR_CCDA);
    const stripCustodian = (d: any) => {
      const c = JSON.parse(JSON.stringify(d));
      delete c.ClinicalDocument.custodian;
      return c;
    };
    expect(stripCustodian(epic)).toEqual(stripCustodian(unknown));
    expect(epic.ClinicalDocument.custodian).not.toEqual(unknown.ClinicalDocument.custodian);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — no handler dereferences a repeatable container
// ---------------------------------------------------------------------------

/**
 * Functions that CONSUME a repeatable container whole rather than dereferencing
 * a property of it, and are therefore safe to hand one directly. Each is
 * array-aware by construction; adding a name here is a claim that it is, and
 * should be justified in review.
 */
const CONTAINER_CONSUMERS = [
  'firstOf', // multivalued.ts — the single occurrence
  'listOf', // multivalued.ts — every occurrence
  'Array.isArray', // a deliberate shape test
  'ccdaSourceId', // record-identity.ts — walks an array of HL7 II elements
  'nameText', // provenance.ts — unwraps a CDA <name> in any of its shapes
  'structuredKey', // fhir-converter/types.ts — serializes the value, does not read into it
];

/** Control keywords whose parenthesised operand is a truthiness test, not a read. */
const TRUTHINESS_CONTEXTS = ['if', 'while', 'return', 'switch'];

/**
 * The call whose argument list encloses `at`, or null when `at` is not inside
 * one. Handles generic arguments (`listOf<any>(…)`) and spreads (`...listOf(…)`).
 */
function enclosingCall(code: string, at: number): string | null {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = code[i];
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth > 0) { depth--; continue; }
      let j = i - 1;
      while (j >= 0 && /\s/.test(code[j])) j--;
      if (code[j] === '>') {
        let d = 0;
        for (; j >= 0; j--) {
          if (code[j] === '>') d++;
          else if (code[j] === '<') { d--; if (d === 0) { j--; break; } }
        }
      }
      const end = j + 1;
      while (j >= 0 && /[A-Za-z0-9_$.]/.test(code[j])) j--;
      return code.slice(j + 1, end).replace(/^\.+/, '');
    }
  }
  return null;
}

describe('no C-CDA handler dereferences a repeatable container', () => {
  it('every `.<repeatable-element>` is consumed whole, never dereferenced or bound raw', () => {
    // Two clauses, because the four shipped instances split evenly between them:
    //   CHAINED — `entry?.organizer?.component` (vitals). Reads a property
    //     straight off the array. Always wrong.
    //   RAW BOUND — `const organizer = entry?.organizer;` (labs, family history,
    //     devices). The array is bound to a local that then reads like an object,
    //     which is why a one-line grep never found these.
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file === LIST_OWNER) continue;
      const code = stripComments(CODE.get(file)!);
      const lines = code.split('\n');
      const lineAt = (i: number) => code.slice(0, i).split('\n').length;

      for (const name of CCDA_MULTIVALUED_ELEMENTS) {
        const re = new RegExp(`\\.\\s*${name}\\b`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
          const ln = lineAt(m.index);
          const text = lines[ln - 1].trim();
          const after = code.slice(m.index + m[0].length);

          if (/^\s*(?:\?\.|\.|\[)/.test(after)) {
            offenders.push(`${file}:${ln}: .${name} dereferenced — ${text}`);
            continue;
          }
          // `x?.entry ? … : …` reads the container only for truthiness.
          if (/^\s*\?[^.]/.test(after)) continue;
          const call = enclosingCall(code, m.index);
          if (call && (CONTAINER_CONSUMERS.includes(call) || TRUTHINESS_CONTEXTS.includes(call))) continue;
          offenders.push(`${file}:${ln}: .${name} read raw — ${text}`);
        }
      }
    }
    expect(
      offenders,
      'A repeatable C-CDA element is an ARRAY on every document. Reading a property off it, or ' +
        'binding it to a local that later does, yields undefined and the section silently ' +
        'produces nothing — that has now happened four times. Consume it with firstOf() or ' +
        `listOf() from ${LIST_OWNER}.`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The accessors themselves
// ---------------------------------------------------------------------------

describe('firstOf / listOf', () => {
  it('firstOf takes the single occurrence from an array, an object, or nothing', () => {
    expect(firstOf([{ a: 1 }, { a: 2 }])).toEqual({ a: 1 });
    expect(firstOf({ a: 1 })).toEqual({ a: 1 });
    expect(firstOf([])).toBeUndefined();
    expect(firstOf(undefined)).toBeUndefined();
    expect(firstOf(null)).toBeUndefined();
  });

  it('listOf always yields an array and drops nothing', () => {
    expect(listOf([{ a: 1 }, { a: 2 }])).toHaveLength(2);
    expect(listOf({ a: 1 })).toHaveLength(1);
    expect(listOf(undefined)).toEqual([]);
    expect(listOf(null)).toEqual([]);
  });

  it('canonicalization is idempotent and does not double-wrap', () => {
    const doc: any = { entry: { organizer: { component: { observation: { x: 1 } } } } };
    canonicalizeMultivaluedElements(doc);
    const once = JSON.parse(JSON.stringify(doc));
    canonicalizeMultivaluedElements(doc);
    expect(doc).toEqual(once);
    expect(Array.isArray(doc.entry)).toBe(true);
    expect(Array.isArray(doc.entry[0].organizer)).toBe(true);
    expect(Array.isArray(doc.entry[0].organizer[0].component)).toBe(true);
  });
});
