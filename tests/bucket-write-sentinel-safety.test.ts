/**
 * The sentinel base must be invisible to pod data, in BOTH directions.
 *
 * `src/lib/bucket-write.ts` parses a bucket under a sentinel base IRI so that a
 * relative IRI survives a re-serialization round trip. That sentinel is an
 * internal implementation detail of one parse, and two properties have to hold
 * for it to stay one:
 *
 *   INBOUND  — untrusted document text can never be mistaken for the sentinel.
 *              An IRI that merely LOOKS like the sentinel is a different, real,
 *              absolute resource; stripping it re-identifies someone's data.
 *              Reachable from third-party Turtle via `pod import`.
 *
 *   OUTBOUND — the sentinel can never survive into a written document. It is
 *              sticky if it does: once `"5"^^<x-cascade-rel:myLocalType>` is on
 *              disk that datatype IRI is ABSOLUTE, so no later parse resolves it
 *              and no later strip removes it. The corruption is permanent.
 *
 * Both were live defects. The fixtures below are the verified reproductions.
 * All fixtures are synthetic and PHI-free.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Parser, DataFactory } from 'n3';
import type { Quad } from 'n3';
import {
  mergeIntoBucket,
  relBase,
  relBaseFor,
  derelativizeQuads,
  assertNoSentinelLeak,
  pickSentinelBase,
  SentinelLeakError,
} from '../src/lib/bucket-write.js';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { runReconciliation } from '../src/lib/reconciler.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;

const NS = {
  clinical: 'https://ns.cascadeprotocol.org/clinical/v1#',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
};

/**
 * Every sentinel-shaped string an attacker could plausibly try, including the
 * exact literal the first implementation used. None of these may ever be
 * treated as "this term was relative in the source".
 */
const HOSTILE_IRIS: Array<[string, string]> = [
  ['a real absolute IRI smuggled behind the sentinel scheme', 'x-cascade-rel:http://real.example/thing'],
  ['a bare local name', 'x-cascade-rel:foo'],
  ['an empty local part', 'x-cascade-rel:'],
  ['a fragment-only local part', 'x-cascade-rel:#f'],
  ['a nonce-shaped scheme', 'x-cascade-rel-0123456789abcdef0123456789abcdef:evil'],
];

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-sentinel-'));
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seed(content: string, name = 'medications.ttl'): string {
  const p = path.join(tmp, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

function strictParse(turtle: string): Quad[] {
  return new Parser({ format: 'Turtle' }).parse(turtle);
}

function recordQuads(uri = 'urn:uuid:NEW'): Quad[] {
  const s = namedNode(uri);
  return [
    makeQuad(s, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'Medication')),
    makeQuad(s, namedNode(NS.clinical + 'drugName'), literal('Vitamin D')),
  ];
}

// ---------------------------------------------------------------------------
// INBOUND: a document that looks like the sentinel is not the sentinel
// ---------------------------------------------------------------------------

describe('sentinel collision: untrusted text is never re-identified', () => {
  for (const [label, iri] of HOSTILE_IRIS) {
    it(`keeps ${label} in SUBJECT position byte-exact`, async () => {
      const p = seed(`<${iri}> <urn:p> "v".\n`);
      await mergeIntoBucket(p, recordQuads(), undefined);
      const subjects = strictParse(fs.readFileSync(p, 'utf-8')).map((q) => q.subject.value);
      expect(subjects, `subject ${iri} was rewritten`).toContain(iri);
    });

    it(`keeps ${label} in OBJECT position byte-exact`, async () => {
      const p = seed(`<urn:s> <urn:p> <${iri}>.\n`);
      await mergeIntoBucket(p, recordQuads(), undefined);
      const objects = strictParse(fs.readFileSync(p, 'utf-8')).map((q) => q.object.value);
      expect(objects, `object ${iri} was rewritten`).toContain(iri);
    });

    it(`keeps ${label} in PREDICATE position byte-exact`, async () => {
      const p = seed(`<urn:s> <${iri}> "v".\n`);
      await mergeIntoBucket(p, recordQuads(), undefined);
      const predicates = strictParse(fs.readFileSync(p, 'utf-8')).map((q) => q.predicate.value);
      expect(predicates, `predicate ${iri} was rewritten`).toContain(iri);
    });
  }

  it('does not re-identify a resource into a DIFFERENT absolute resource', async () => {
    // The sharp edge. Stripping turns a statement about an x-cascade-rel:
    // resource into a statement about `http://real.example/thing` — a real
    // resource on a real host that the document never mentioned.
    const p = seed(`<x-cascade-rel:http://real.example/thing> <urn:p> "v".\n`);
    await mergeIntoBucket(p, recordQuads(), undefined);
    const subjects = strictParse(fs.readFileSync(p, 'utf-8')).map((q) => q.subject.value);
    expect(subjects).not.toContain('http://real.example/thing');
  });

  it('is stable: a hostile IRI survives five successive merges unchanged', async () => {
    const p = seed(`<x-cascade-rel:http://real.example/thing> <urn:p> <x-cascade-rel:foo>.\n`);
    for (let i = 0; i < 5; i++) {
      await mergeIntoBucket(p, recordQuads(`urn:uuid:N${i}`), undefined);
      const quads = strictParse(fs.readFileSync(p, 'utf-8'));
      const hit = quads.find((q) => q.predicate.value === 'urn:p');
      expect(hit?.subject.value, `merge ${i + 1}`).toBe('x-cascade-rel:http://real.example/thing');
      expect(hit?.object.value, `merge ${i + 1}`).toBe('x-cascade-rel:foo');
    }
  });

  it('still resolves genuinely relative IRIs while refusing the lookalikes', async () => {
    // Both properties at once: the real relative IRI round-trips as a relative
    // IRI, and the lookalike beside it is untouched.
    const p = seed(`<urn:s> <urn:p> </profile/card.ttl#me>; <urn:q> <x-cascade-rel:foo>.\n`);
    await mergeIntoBucket(p, recordQuads(), undefined);
    const out = fs.readFileSync(p, 'utf-8');
    expect(out).toContain('</profile/card.ttl#me>');
    expect(out).toContain('<x-cascade-rel:foo>');
  });
});

// ---------------------------------------------------------------------------
// OUTBOUND: the sentinel never reaches disk, from ANY term position
// ---------------------------------------------------------------------------

/** Any IRI in the sentinel FAMILY, whatever nonce it carries. */
const SENTINEL_RE = /x-cascade-rel/;

describe('sentinel leak: no term position lets the sentinel reach disk', () => {
  const RELATIVE_IN_EVERY_POSITION: Array<[string, string]> = [
    ['subject', `</records/1> <urn:p> "v".`],
    ['predicate', `<urn:s> </vocab#p> "v".`],
    ['object', `<urn:s> <urn:p> </profile/card.ttl#me>.`],
    // The leak that shipped: a literal's DATATYPE is a NamedNode too.
    ['literal datatype', `<urn:s> <urn:p> "5"^^<myLocalType>.`],
    ['literal datatype, doc-relative', `<urn:s> <urn:p> "5"^^<vocab/myType>.`],
    ['literal datatype, fragment-only', `<urn:s> <urn:p> "5"^^<#myType>.`],
    ['literal datatype, empty', `<urn:s> <urn:p> "5"^^<>.`],
    ['inside a collection', `<urn:s> <urn:p> ( </a> </b> ).`],
    ['inside a blank node', `<urn:s> <urn:p> [ <urn:q> </a>; <urn:r> "5"^^<myType> ].`],
  ];

  for (const [label, ttl] of RELATIVE_IN_EVERY_POSITION) {
    it(`does not leak the sentinel from a relative IRI in ${label}`, async () => {
      const p = seed(ttl + '\n');
      await mergeIntoBucket(p, recordQuads(), undefined);
      expect(fs.readFileSync(p, 'utf-8')).not.toMatch(SENTINEL_RE);
    });

    it(`keeps ${label} stable, and unpolluted, across three writes`, async () => {
      // Stickiness is what makes this permanent: once the sentinel is on disk
      // the IRI is ABSOLUTE, so no later parse resolves it and no later strip
      // removes it. One contaminated write is forever.
      const p = seed(ttl + '\n');
      for (let i = 0; i < 3; i++) {
        await mergeIntoBucket(p, recordQuads(`urn:uuid:N${i}`), undefined);
        expect(fs.readFileSync(p, 'utf-8'), `write ${i + 1}`).not.toMatch(SENTINEL_RE);
      }
    });
  }

  it('preserves the relative datatype IRI exactly, not just "not the sentinel"', async () => {
    const p = seed(`<urn:s> <urn:p> "5"^^<myLocalType>.\n`);
    await mergeIntoBucket(p, recordQuads(), undefined);
    const out = fs.readFileSync(p, 'utf-8');
    expect(out).toContain('^^<myLocalType>');
    const dt = strictParse(out).find((q) => q.predicate.value === 'urn:p');
    expect(dt?.object.termType).toBe('Literal');
    expect((dt?.object as { datatype: { value: string } }).datatype.value).toBe('myLocalType');
  });

  it('keeps a language tag intact while covering the datatype', async () => {
    // rdf:langString is absolute, so it must survive untouched — and the
    // language must not be dropped by whatever rebuilds the literal.
    const p = seed(`<urn:s> <urn:p> "hola"@es; <urn:q> "5"^^<myLocalType>.\n`);
    await mergeIntoBucket(p, recordQuads(), undefined);
    const out = fs.readFileSync(p, 'utf-8');
    expect(out).toContain('"hola"@es');
    expect(out).not.toMatch(SENTINEL_RE);
  });

  it('sweeps every emitted term of a document that is relative throughout', async () => {
    const p = seed(
      `</records/1> </vocab#p> </profile/card.ttl#me>.\n` +
      `</records/1> </vocab#q> "5"^^<myType>.\n` +
      `</records/1> </vocab#r> [ </vocab#s> <#frag> ].\n`,
    );
    await mergeIntoBucket(p, recordQuads(), undefined);
    const out = fs.readFileSync(p, 'utf-8');
    expect(out).not.toMatch(SENTINEL_RE);
    for (const q of strictParse(out)) {
      for (const v of [q.subject.value, q.predicate.value, q.object.value, q.graph.value]) {
        expect(v).not.toMatch(SENTINEL_RE);
      }
      if (q.object.termType === 'Literal') {
        expect(q.object.datatype.value).not.toMatch(SENTINEL_RE);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The sentinel itself: shape, unguessability, and the coverage tripwire
// ---------------------------------------------------------------------------

describe('the sentinel is a per-process nonce, not a literal', () => {
  it('is unguessable: 128 random bits in the scheme', () => {
    // A fixed literal is forgeable, and forging it re-identifies a resource.
    // Only entropy makes "this term starts with the base" mean "N3 resolved it".
    expect(relBase()).toMatch(/^x-cascade-rel-[0-9a-f]{32}:$/);
  });

  it('is a BARE SCHEME, which is what makes root-relative IRIs resolvable', () => {
    // N3 resolves a root-relative `</x>` against `_baseRoot`, which it derives
    // as `/^(?:([a-z][a-z0-9+.-]*:))?(?:\/\/[^/]*)?/i`. Anything with structure
    // after the scheme (`urn:x-cascade-rel-<nonce>:`) makes `_baseRoot` just
    // `urn:`, so `</profile/card.ttl#me>` resolves to `urn:/profile/card.ttl#me`
    // — no sentinel, never stripped, silently a different resource.
    const base = relBase();
    expect(base.indexOf(':')).toBe(base.length - 1);
    expect(base).not.toContain('/');
    expect(base.slice(0, -1)).toMatch(/^[a-z][a-z0-9+.-]*$/);
  });

  it('actually round-trips all four relative forms through a real parse', async () => {
    // The property the bare-scheme shape exists to buy, asserted end to end
    // rather than by reading the regex.
    const p = seed(
      `<urn:s> <urn:a> </profile/card.ttl#me>; <urn:b> <profile/card.ttl>; <urn:c> <>; <urn:d> <#me>.\n`,
    );
    await mergeIntoBucket(p, recordQuads(), undefined);
    const out = fs.readFileSync(p, 'utf-8');
    for (const form of ['</profile/card.ttl#me>', '<profile/card.ttl>', '<>', '<#me>']) {
      expect(out, `relative form ${form} was rewritten`).toContain(form);
    }
    expect(out).not.toMatch(SENTINEL_RE);
  });

  it('regenerates rather than reusing a base the source text already contains', () => {
    // Belt and braces on top of the entropy: the guarantee is not "an attacker
    // is unlikely to collide", it is "a collision cannot happen", because a
    // text holding the active base never gets parsed under it.
    const before = relBase();
    const chosen = relBaseFor(`<${before}evil> <urn:p> "v".`);
    expect(chosen).not.toBe(before);
    expect(chosen).toMatch(/^x-cascade-rel-[0-9a-f]{32}:$/);
    // ...and a text that does NOT contain it keeps the process base stable, so
    // quads already in flight under it are still stripped.
    expect(relBaseFor('<urn:s> <urn:p> "v".')).toBe(chosen);
  });

  it('keeps the current base when the text does not contain it', () => {
    expect(pickSentinelBase('nothing to see here', 'A:', () => 'B:')).toBe('A:');
  });

  it('draws again when the text does contain it', () => {
    expect(pickSentinelBase('this has A: in it', 'A:', () => 'B:')).toBe('B:');
  });

  it('gives up rather than spinning when minting stops being random', () => {
    // The retry has to be BOUNDED. It terminates only because minting is
    // random — a property of another function entirely. Point it at a mint
    // that always returns the same colliding value and an unbounded loop hangs
    // the CLI forever, silently, on any input containing the sentinel. Not
    // hypothetical: mutating the nonce back to a fixed literal to test this
    // module's own tripwires burned 22 minutes of CPU in exactly this hang.
    expect(() => pickSentinelBase('text with FIXED: inside', 'FIXED:', () => 'FIXED:'))
      .toThrow(/draws|random/);
  });

  it('never lets a superseded base slip through unnoticed', () => {
    // After a regeneration, a quad still carrying the OLD base is not stripped
    // by the new one. It must not be written either.
    const stale = relBase();
    relBaseFor(`<${stale}x> <urn:p> "v".`);
    expect(relBase()).not.toBe(stale);
    expect(() => assertNoSentinelLeak([
      makeQuad(namedNode(stale + '/records/1'), namedNode('urn:p'), literal('v')),
    ])).toThrow(SentinelLeakError);
  });
});

describe('the leak assertion is a real tripwire, not decoration', () => {
  /** A term that MENTIONS the sentinel without starting with it, so no strip applies. */
  const smuggled = () => 'http://ex.org/' + relBase();

  it('throws rather than writing a term that still mentions the sentinel', async () => {
    const p = path.join(tmp, 'x.ttl');
    await expect(
      mergeIntoBucket(p, [makeQuad(namedNode('urn:s'), namedNode('urn:p'), namedNode(smuggled()))], undefined),
    ).rejects.toBeInstanceOf(SentinelLeakError);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('leaves an existing bucket byte-identical when it fires', async () => {
    const p = seed(`<urn:uuid:OLD> <urn:p> "v".\n`);
    const before = fs.readFileSync(p);
    await expect(
      mergeIntoBucket(p, [makeQuad(namedNode('urn:s'), namedNode('urn:p'), namedNode(smuggled()))], undefined),
    ).rejects.toBeInstanceOf(SentinelLeakError);
    expect(fs.readFileSync(p).equals(before)).toBe(true);
  });

  it('catches a leak in every term position, datatype and graph included', () => {
    const s = namedNode('urn:s');
    const p = namedNode('urn:p');
    const cases: Array<[string, Quad]> = [
      ['subject', makeQuad(namedNode(smuggled()), p, literal('v'))],
      ['predicate', makeQuad(s, namedNode(smuggled()), literal('v'))],
      ['object', makeQuad(s, p, namedNode(smuggled()))],
      ['literal datatype', makeQuad(s, p, literal('5', namedNode(smuggled())))],
      ['literal lexical form', makeQuad(s, p, literal(smuggled()))],
      ['graph', makeQuad(s, p, literal('v'), namedNode(smuggled()))],
    ];
    for (const [label, q] of cases) {
      expect(() => assertNoSentinelLeak([q]), `${label} leak was not caught`).toThrow(SentinelLeakError);
    }
  });

  it('passes clean quads, including ones that merely look sentinel-ish', () => {
    expect(() => assertNoSentinelLeak([
      ...recordQuads(),
      makeQuad(namedNode('x-cascade-rel:foo'), namedNode('urn:p'), literal('v')),
      makeQuad(namedNode('urn:s'), namedNode('urn:p'), literal('5', namedNode('myLocalType'))),
    ])).not.toThrow();
  });
});

describe('no Turtle this CLI produces mentions the sentinel, intermediate included', () => {
  it('the reconciler derelativizes its own output before handing it on', async () => {
    // The reconciler parses pod text under the sentinel and re-serializes. Its
    // output is INTERMEDIATE — `pod import` re-parses it — so a sentinel left
    // attached here is never resolved by that second parse, never stripped, and
    // reaches disk absolute and permanent. Keeping the invariant global (no
    // Turtle at all, at any stage) is what makes `relBaseFor`'s "the source
    // never contains the base" precondition true everywhere.
    const { turtle } = await runReconciliation([
      {
        systemName: 'test',
        content:
          `@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#>.\n` +
          `@prefix prov: <http://www.w3.org/ns/prov#>.\n` +
          `<urn:uuid:A> a clinical:Medication; clinical:drugName "Metformin";\n` +
          `  prov:wasAttributedTo </profile/card.ttl#me>.\n` +
          `<urn:uuid:B> <urn:p> </records/passthrough>.\n`,
      },
    ]);
    expect(turtle).not.toMatch(SENTINEL_RE);
    // ...and the relative IRIs came back out relative, in both a reconciled
    // record and a passthrough subject.
    expect(turtle).toContain('</profile/card.ttl#me>');
    expect(turtle).toContain('</records/passthrough>');
  }, 60_000);
});

describe('derelativizeQuads covers every term position', () => {
  it('strips the sentinel from subject, predicate, object, datatype and graph', () => {
    const base = relBase();
    const q = makeQuad(
      namedNode(base + '/records/1'),
      namedNode(base + '/vocab#p'),
      literal('5', namedNode(base + 'myType')),
      namedNode(base + '/graphs/g'),
    );
    const [out] = derelativizeQuads([q], base);
    expect(out.subject.value).toBe('/records/1');
    expect(out.predicate.value).toBe('/vocab#p');
    expect((out.object as { datatype: { value: string } }).datatype.value).toBe('myType');
    expect(out.graph.value).toBe('/graphs/g');
  });

  it('keeps a language tag when it rebuilds a literal', () => {
    const base = relBase();
    const [out] = derelativizeQuads(
      [makeQuad(namedNode('urn:s'), namedNode(base + 'p'), literal('hola', 'es'))],
      base,
    );
    expect(out.object.value).toBe('hola');
    expect((out.object as { language: string }).language).toBe('es');
  });

  it('recurses into a nested RDF-star quad term', () => {
    // Reachable: `turtle-parser.ts` leaves `format` unset, which turns n3's
    // RDF-star support ON, and `pod erase` reads through it.
    const base = relBase();
    const inner = makeQuad(namedNode(base + '/records/1'), namedNode('urn:q'), literal('v'));
    const outer = makeQuad(namedNode('urn:s'), namedNode('urn:p'), inner as unknown as ReturnType<typeof namedNode>);
    const [out] = derelativizeQuads([outer], base);
    const nested = out.object as unknown as Quad;
    expect(nested.subject.value).toBe('/records/1');
    expect(() => assertNoSentinelLeak([out])).not.toThrow();
  });

  it('is a no-op on a term that only LOOKS like the sentinel', () => {
    const q = makeQuad(namedNode('x-cascade-rel:foo'), namedNode('urn:p'), literal('v'));
    expect(derelativizeQuads([q], relBase())[0]).toBe(q);
  });
});

// ---------------------------------------------------------------------------
// End to end, through the vector that was actually reachable
// ---------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();
  program
    .name('cascade')
    .exitOverride()
    .option('--verbose', 'Verbose output', false)
    .option('--json', 'Output JSON', false);
  registerPodCommand(program);
  return program;
}

async function runCli(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  process.exitCode = 0;
  try {
    await buildProgram().parseAsync(['node', 'cascade', ...args]);
  } catch {
    /* exitOverride throws; exitCode carries the failure */
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: chunks.join('\n'), exitCode };
}

/**
 * The reproduction, verbatim: third-party Turtle carrying a sentinel-shaped
 * subject, a sentinel-shaped object and a relative datatype, imported into a
 * clean pod. Exit 0 and "Records imported: 1" is what made it silent.
 */
const THIRD_PARTY_TURTLE = `@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#>.
<x-cascade-rel:http://real.example/thing> a clinical:Medication;
    clinical:drugName "Aspirin";
    clinical:code <x-cascade-rel:http://registry.example/code/1>;
    clinical:dosage "5"^^<myLocalType>.
`;

describe('end to end: pod import of third-party Turtle', () => {
  it('neither re-identifies the subject nor leaks the sentinel into the datatype', async () => {
    const podDir = path.join(tmp, 'pod');
    const input = path.join(tmp, 'third-party.ttl');
    fs.writeFileSync(input, THIRD_PARTY_TURTLE, 'utf-8');

    expect((await runCli(['pod', 'init', podDir])).exitCode).toBe(0);
    expect((await runCli(['pod', 'import', podDir, input])).exitCode).toBe(0);

    const bucket = fs.readFileSync(path.join(podDir, 'clinical', 'medications.ttl'), 'utf-8');
    // INBOUND: the subject and the coded object are still the resources the
    // source named, not the absolute resources hiding behind the scheme.
    expect(bucket).toContain('<x-cascade-rel:http://real.example/thing>');
    expect(bucket).toContain('<x-cascade-rel:http://registry.example/code/1>');
    expect(bucket).not.toContain('<http://real.example/thing>');
    expect(bucket).not.toContain('<http://registry.example/code/1>');
    // OUTBOUND: the relative datatype came back relative.
    expect(bucket).toContain('^^<myLocalType>');
    expect(bucket).not.toContain('^^<x-cascade-rel');
  }, 60_000);

  it('survives a later add-record without contaminating or rewriting anything', async () => {
    // Stickiness is only visible on the SECOND write: an absolute
    // x-cascade-rel: datatype is never resolved again, so it can never be
    // cleaned up by a later pass.
    const podDir = path.join(tmp, 'pod');
    const input = path.join(tmp, 'third-party.ttl');
    fs.writeFileSync(input, THIRD_PARTY_TURTLE, 'utf-8');

    await runCli(['pod', 'init', podDir]);
    await runCli(['pod', 'import', podDir, input]);
    const add = await runCli([
      'pod', 'add-record', podDir,
      '--type', 'clinical:Medication',
      '--json', '{"clinical:drugName":"Vitamin D"}',
    ]);
    expect(add.exitCode).toBe(0);

    const bucket = fs.readFileSync(path.join(podDir, 'clinical', 'medications.ttl'), 'utf-8');
    expect(bucket).toContain('<x-cascade-rel:http://real.example/thing>');
    expect(bucket).toContain('^^<myLocalType>');
    expect(bucket).not.toContain('^^<x-cascade-rel');
    // The pod's own relative WebID still round-trips.
    expect(bucket).toContain('prov:wasAttributedTo </profile/card.ttl#me>');
  }, 60_000);
});
