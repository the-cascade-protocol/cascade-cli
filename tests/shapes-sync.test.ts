/**
 * The bundled vocabulary must define every class the bundled shapes target.
 *
 * WHAT WENT WRONG, AND WHY NO EXISTING TEST SAW IT
 * ------------------------------------------------
 * `src/shapes/` holds two kinds of file and `loadShapes()` reads both: every
 * `*.shapes.ttl` supplies SHACL constraints, and every other `*.ttl` supplies the
 * vocabulary those constraints are written against. The sync script kept two
 * independent lists — one naming the vocabularies whose *shapes* to copy (six
 * stable plus four drafts) and one naming the vocabularies whose *ontology* to
 * copy (three: core, clinical, coverage). Nothing tied them together, so the
 * second list simply never grew.
 *
 * The result is a validator that loads a shape whose target class its own loaded
 * vocabulary does not define. That is silent by construction: SHACL resolves
 * `sh:targetClass` against the data graph, so an undefined target is not an
 * error, it is a shape that quietly selects nothing and reports nothing. A file
 * full of such subjects returns `conforms: true`, which reads as "checked and
 * clean" and means "never checked".
 *
 * Measured before the fix: 52 of 89 `sh:targetClass` values in Cascade
 * namespaces resolved to no loaded class, and `src/shapes/health.ttl` was 928
 * lines against the 1489 it should have been — it had never been synced once.
 *
 * WHAT THESE WOULD DO IF THE FIX WERE ABSENT
 * ------------------------------------------
 * Measured against the pre-sync tree at commit 1750f16:
 *   - `every shapes file has a matching ontology file` FAILS: 10 shapes files,
 *     4 ontology files, 6 missing (health, checkup, pots, genomics, advisory,
 *     evidence, workbench — health being the one with a stable released version).
 *   - `every Cascade sh:targetClass resolves` FAILS with 52 unresolved targets
 *     across 7 vocabularies, health:SocialHistoryRecord among them.
 *   - `VOCAB_VERSIONS matches the synced ontology` FAILS on health: the file
 *     said 2.4 while the never-synced ontology declared 2.3.
 *
 * These assert on parsed RDF terms and on file inventories, never on substrings
 * of prose, so no comment or changelog line anywhere can make one pass by
 * coincidence.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Store, DataFactory } from 'n3';

const { namedNode } = DataFactory;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_SHAPES = path.join(REPO, 'src', 'shapes');
const DIST_SHAPES = path.join(REPO, 'dist', 'shapes');

const SH = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const CASCADE_NS_PREFIX = 'https://ns.cascadeprotocol.org/';

/**
 * `sh:targetClass` values outside the Cascade namespaces. These are classes
 * owned by other vocabularies, so no Cascade ontology will ever define them and
 * requiring resolution would be wrong.
 *
 * Pinned as an exact set rather than waved through by a namespace test: adding a
 * dependency on a foreign vocabulary is a decision, and it should show up as a
 * failing assertion that someone has to look at.
 */
const EXTERNAL_TARGET_CLASSES = new Set([
  // W3C Web Annotation Data Model, targeted by workbench:WebAnnotationShape.
  'http://www.w3.org/ns/oa#Annotation',
]);

/**
 * Cascade-namespace target classes that are known NOT to resolve, with the
 * reason. Each one is a defect in `spec`, not in the sync.
 *
 * checkup v3.0 removed the classes `checkup:PatientProfile` and
 * `checkup:VitalSignsTrend` (its changelog records the removal, and
 * `checkup:hasPatientProfile` / `hasVitalsTrend` carry DEPRECATED comments
 * pointing at the replacements) but `checkup.shapes.ttl` still declares
 * `PatientProfileShape` and `VitalSignsTrendShape` with `sh:targetClass` on the
 * removed names. Both shapes are still reachable through `sh:node` from their
 * parent shapes, so only the class target is dead — which is precisely why it
 * survived: nothing about it is visibly broken from inside the shapes file.
 *
 * The entry below is deliberately not a free pass. The staleness assertion just
 * under it fails if one of these ever DOES resolve, so when `spec` removes the
 * orphaned shapes this list must shrink in the same change.
 */
const KNOWN_UNRESOLVED_TARGET_CLASSES = new Set([
  'https://ns.cascadeprotocol.org/checkup/v1#PatientProfile',
  'https://ns.cascadeprotocol.org/checkup/v1#VitalSignsTrend',
]);

interface LoadedShapesDir {
  shapesFiles: string[];
  ontologyFiles: string[];
  /** Constraints only. */
  shapesStore: Store;
  /** Vocabulary only. */
  vocabStore: Store;
}

function loadShapesDir(dir: string): LoadedShapesDir {
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.ttl')).sort();
  const shapesFiles = all.filter((f) => f.endsWith('.shapes.ttl'));
  const ontologyFiles = all.filter((f) => !f.endsWith('.shapes.ttl'));

  const shapesStore = new Store();
  const vocabStore = new Store();
  for (const f of all) {
    const target = f.endsWith('.shapes.ttl') ? shapesStore : vocabStore;
    const quads = new Parser().parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    for (const q of quads) target.addQuad(q);
  }
  return { shapesFiles, ontologyFiles, shapesStore, vocabStore };
}

/** Vocabulary stem, e.g. `health.shapes.ttl` and `health.ttl` both -> `health`. */
function stem(file: string): string {
  return file.replace(/\.shapes\.ttl$/, '').replace(/\.ttl$/, '');
}

function declaredClasses(vocabStore: Store): Set<string> {
  const out = new Set<string>();
  for (const classType of [`${OWL}Class`, `${RDFS}Class`]) {
    for (const q of vocabStore.getQuads(null, namedNode(RDF_TYPE), namedNode(classType), null)) {
      out.add(q.subject.value);
    }
  }
  return out;
}

/** `sh:targetClass` value -> the shapes that declare it, for a readable failure. */
function targetClasses(shapesStore: Store): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const q of shapesStore.getQuads(null, namedNode(`${SH}targetClass`), null, null)) {
    const existing = out.get(q.object.value);
    if (existing) existing.push(q.subject.value);
    else out.set(q.object.value, [q.subject.value]);
  }
  return out;
}

const src = loadShapesDir(SRC_SHAPES);

describe('bundled shapes and the vocabulary they are written against', () => {
  it('ships an ontology for every shapes file, and a shapes file for every ontology', () => {
    const shapeStems = new Set(src.shapesFiles.map(stem));
    const ontologyStems = new Set(src.ontologyFiles.map(stem));

    // Stated as sorted arrays so a failure names the missing vocabularies rather
    // than printing two set sizes.
    expect([...shapeStems].sort()).toEqual([...ontologyStems].sort());
  });

  it('resolves every Cascade-namespace sh:targetClass to a defined class', () => {
    const defined = declaredClasses(src.vocabStore);
    const targets = targetClasses(src.shapesStore);

    const unresolved: string[] = [];
    for (const [cls, shapes] of targets) {
      if (!cls.startsWith(CASCADE_NS_PREFIX)) continue;
      if (defined.has(cls)) continue;
      if (KNOWN_UNRESOLVED_TARGET_CLASSES.has(cls)) continue;
      unresolved.push(`${cls} (targeted by ${shapes.join(', ')})`);
    }

    expect(unresolved.sort()).toEqual([]);
  });

  it('has no stale entry in the known-unresolved list', () => {
    const defined = declaredClasses(src.vocabStore);
    const nowResolving = [...KNOWN_UNRESOLVED_TARGET_CLASSES].filter((c) => defined.has(c));

    // If spec defines one of these again, or removes the orphaned shape, the
    // exemption has to go with it — otherwise the list slowly becomes a place to
    // hide real breakage.
    expect(nowResolving.sort()).toEqual([]);
  });

  it('targets no foreign class beyond the ones explicitly accepted', () => {
    const external = [...targetClasses(src.shapesStore).keys()]
      .filter((c) => !c.startsWith(CASCADE_NS_PREFIX))
      .filter((c) => !EXTERNAL_TARGET_CLASSES.has(c));

    expect(external.sort()).toEqual([]);
  });

  it('actually targets something — the assertions above are not vacuous', () => {
    const targets = targetClasses(src.shapesStore);
    const cascadeTargets = [...targets.keys()].filter((c) => c.startsWith(CASCADE_NS_PREFIX));

    // An empty shapes directory would satisfy every assertion above. These
    // floors are set below the current counts (107 Cascade targets, 194 defined
    // classes) so ordinary vocabulary growth does not touch them, but a sync that
    // silently produced nothing would.
    expect(cascadeTargets.length).toBeGreaterThan(90);
    expect(declaredClasses(src.vocabStore).size).toBeGreaterThan(150);
    expect(src.shapesFiles.length).toBeGreaterThan(8);
  });
});

describe('VOCAB_VERSIONS against the ontologies actually bundled', () => {
  const rows = new Map<string, string>();
  for (const line of fs.readFileSync(path.join(REPO, 'VOCAB_VERSIONS'), 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [k, v] = trimmed.split('=');
    rows.set(k, v);
  }

  it('declares a version for each stable vocabulary', () => {
    expect([...rows.keys()].sort()).toEqual(
      ['checkup', 'clinical', 'core', 'coverage', 'health', 'pots'],
    );
  });

  it.each([...rows.keys()])(
    'the bundled %s ontology declares the version VOCAB_VERSIONS claims',
    (vocab) => {
      const file = path.join(SRC_SHAPES, `${vocab}.ttl`);
      expect(fs.existsSync(file), `${vocab}.ttl is not bundled`).toBe(true);

      const store = new Store();
      for (const q of new Parser().parse(fs.readFileSync(file, 'utf-8'))) store.addQuad(q);

      // The version on the owl:Ontology node itself, not the per-term
      // `owl:versionInfo "Added in health v2.4"` annotations that share the
      // predicate.
      const ontologyNodes = store
        .getQuads(null, namedNode(RDF_TYPE), namedNode(`${OWL}Ontology`), null)
        .map((q) => q.subject);
      expect(ontologyNodes.length, `${vocab}.ttl declares no owl:Ontology`).toBe(1);

      const versions = store
        .getQuads(ontologyNodes[0], namedNode(`${OWL}versionInfo`), null, null)
        .map((q) => q.object.value);

      // This is the assertion that makes a stale bundle loud: bumping the row
      // without re-running the sync fails here, and so does re-running the sync
      // without bumping the row.
      expect(versions).toContain(rows.get(vocab));
    },
  );
});

describe('the built bundle the CLI actually loads', () => {
  it('mirrors src/shapes byte for byte', () => {
    // `getShapesDir()` resolves to `dist/shapes` at runtime, so every measurement
    // taken from a `cascade validate` run reflects dist, not src. Editing src and
    // reading the old dist result as "no change" is a live trap; this is the
    // assertion that removes it.
    expect(fs.existsSync(DIST_SHAPES), 'dist/shapes is missing — run `npm run build`').toBe(true);

    const distFiles = fs.readdirSync(DIST_SHAPES).filter((f) => f.endsWith('.ttl')).sort();
    const srcFiles = [...src.shapesFiles, ...src.ontologyFiles].sort();
    expect(distFiles).toEqual(srcFiles);

    const differing = srcFiles.filter(
      (f) =>
        !fs
          .readFileSync(path.join(SRC_SHAPES, f))
          .equals(fs.readFileSync(path.join(DIST_SHAPES, f))),
    );
    expect(differing).toEqual([]);
  });
});
