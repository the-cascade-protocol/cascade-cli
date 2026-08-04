/**
 * Shape-coverage reporting.
 *
 * `cascade validate` used to return PASS on a file no shape targeted, and to
 * print a `Shapes:` line naming shape files that ran nothing, because shape
 * reporting matched the prefixes a file declared rather than the shapes that
 * actually selected a focus node. These tests pin both halves: the count of
 * subjects no shape applies to, and the requirement that a named shape fired.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadShapes, validateTurtle } from '../src/lib/shacl-validator.js';

const PREFIXES = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <http://example.org/> .
`;

/** Write a throwaway shapes directory and load it. */
function withShapes(files: Record<string, string>): ReturnType<typeof loadShapes> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-coverage-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), PREFIXES + content, 'utf-8');
  }
  return loadShapes(dir);
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A shape requiring ex:required on every instance of ex:Super. */
const SUPER_SHAPE = `
ex:SuperShape a sh:NodeShape ;
    sh:targetClass ex:Super ;
    sh:property [ sh:path ex:required ; sh:minCount 1 ; sh:message "ex:required is missing" ] .
`;

describe('shape coverage: class targeting', () => {
  let shapes: ReturnType<typeof loadShapes>;
  beforeAll(() => {
    shapes = withShapes({ 'example.shapes.ttl': SUPER_SHAPE });
  });

  const validate = (data: string) =>
    validateTurtle(PREFIXES + data, shapes.store, shapes.shapeFiles, 'test.ttl');

  it('counts a subject of the exact target class as checked', () => {
    const result = validate('ex:a a ex:Super ; ex:required "x" .');
    expect(result.coverage.totalSubjects).toBe(1);
    expect(result.coverage.checkedSubjects).toBe(1);
    expect(result.coverage.unshapedSubjects).toHaveLength(0);
  });

  it('counts a subject of an unrelated type as unshaped, and names the type', () => {
    const result = validate('ex:b a ex:Unrelated ; ex:whatever "x" .');
    expect(result.coverage.totalSubjects).toBe(1);
    expect(result.coverage.checkedSubjects).toBe(0);
    expect(result.coverage.unshapedSubjects.map((s) => s.uri)).toEqual([
      'http://example.org/b',
    ]);
    expect(result.coverage.unshapedTypes).toEqual([
      { type: 'http://example.org/Unrelated', count: 1 },
    ]);
    // The engine agrees nothing ran: a conforming report over zero constraints.
    expect(result.valid).toBe(true);
    expect(result.results).toHaveLength(0);
  });

  it('counts a subclass-typed subject as checked (SHACL 2.1.3.1)', () => {
    // A shape targeting ex:Super must cover a subject typed ex:Sub. Exact-type
    // matching would report this subject as unshaped.
    const result = validate(`
      ex:Sub rdfs:subClassOf ex:Super .
      ex:c a ex:Sub ; ex:required "x" .
    `);
    const cSubject = result.coverage.unshapedSubjects.find(
      (s) => s.uri === 'http://example.org/c',
    );
    expect(cSubject).toBeUndefined();
    expect(result.coverage.checkedSubjects).toBeGreaterThanOrEqual(1);
  });

  it('follows rdfs:subClassOf transitively, not one hop', () => {
    const result = validate(`
      ex:Mid rdfs:subClassOf ex:Super .
      ex:Leaf rdfs:subClassOf ex:Mid .
      ex:d a ex:Leaf .
    `);
    // Two hops from ex:Leaf to ex:Super. A single-hop implementation reports
    // ex:d as unshaped; a transitive one runs the shape and reports the
    // missing ex:required.
    expect(result.coverage.unshapedSubjects.map((s) => s.uri)).not.toContain(
      'http://example.org/d',
    );
    expect(result.valid).toBe(false);
    expect(result.results.map((r) => r.message)).toContain('ex:required is missing');
  });

  it('terminates on a subClassOf cycle and reports the subject as unshaped', () => {
    const result = validate(`
      ex:Ring rdfs:subClassOf ex:Loop .
      ex:Loop rdfs:subClassOf ex:Ring .
      ex:e a ex:Ring .
    `);
    expect(result.coverage.unshapedSubjects.map((s) => s.uri)).toContain(
      'http://example.org/e',
    );
  });

  it('reports every subject as unshaped when no shape targets anything present', () => {
    const result = validate(`
      ex:f a ex:Unrelated .
      ex:g a ex:AlsoUnrelated .
      ex:h a ex:Unrelated .
    `);
    expect(result.coverage.totalSubjects).toBe(3);
    expect(result.coverage.checkedSubjects).toBe(0);
    // Sorted by descending count, then IRI, so output is stable.
    expect(result.coverage.unshapedTypes).toEqual([
      { type: 'http://example.org/Unrelated', count: 2 },
      { type: 'http://example.org/AlsoUnrelated', count: 1 },
    ]);
  });
});

describe('shape coverage: subclass axioms that live only in the ontology', () => {
  // The SHACL specification defines a class target over SHACL instances "in the
  // data graph", so an rdfs:subClassOf axiom present only in the ontology does
  // NOT activate a superclass shape. The engine behaves that way; coverage
  // reporting must agree with the engine rather than with the ontology, or it
  // would report constraints as having run when they did not.
  it('does not count the subject as checked, matching engine behaviour', () => {
    const shapes = withShapes({
      'example.shapes.ttl': SUPER_SHAPE,
      // Loaded as a vocabulary file into the shapes graph, not the data graph.
      'example.ttl': 'ex:OntoSub rdfs:subClassOf ex:Super .\n',
    });
    const result = validateTurtle(
      `${PREFIXES}ex:i a ex:OntoSub .`,
      shapes.store,
      shapes.shapeFiles,
      'test.ttl',
    );

    // The engine ran no constraint: ex:required is absent yet nothing failed.
    expect(result.valid).toBe(true);
    expect(result.results).toHaveLength(0);
    // Coverage reports that honestly.
    expect(result.coverage.checkedSubjects).toBe(0);
    expect(result.coverage.unshapedSubjects.map((s) => s.uri)).toEqual([
      'http://example.org/i',
    ]);
  });
});

describe('shape coverage: nodes reached through sh:node', () => {
  it('counts a node validated via a parent shape as checked', () => {
    const shapes = withShapes({
      'example.shapes.ttl': `
ex:ParentShape a sh:NodeShape ;
    sh:targetClass ex:Parent ;
    sh:property [ sh:path ex:child ; sh:node ex:ChildShape ] .

ex:ChildShape a sh:NodeShape ;
    sh:property [ sh:path ex:childRequired ; sh:minCount 1 ; sh:message "child field missing" ] .
`,
    });

    const result = validateTurtle(
      `${PREFIXES}
      ex:parent a ex:Parent ; ex:child ex:kid .
      ex:kid a ex:ChildType .
      `,
      shapes.store,
      shapes.shapeFiles,
      'test.ttl',
    );

    // ex:kid's own type is targeted by nothing, but the parent shape hands it
    // to ex:ChildShape, so it genuinely is validated. Proof: the engine could
    // only have decided ex:kid fails ex:ChildShape by evaluating it. (The
    // engine surfaces sh:node failures against the parent focus node, naming
    // the offending value, rather than reporting the inner message.)
    expect(result.valid).toBe(false);
    const nodeFailure = result.results.find((r) => r.value === 'http://example.org/kid');
    expect(nodeFailure).toBeDefined();
    expect(nodeFailure?.message).toContain('ChildShape');
    expect(nodeFailure?.focusNode).toBe('http://example.org/parent');

    // Therefore reporting ex:kid as having "no applicable shape" would be false.
    expect(result.coverage.unshapedSubjects.map((s) => s.uri)).not.toContain(
      'http://example.org/kid',
    );
    expect(result.coverage.checkedSubjects).toBe(2);
    expect(result.coverage.totalSubjects).toBe(2);
  });

  it('still reports a node the parent shape never reaches', () => {
    const shapes = withShapes({
      'example.shapes.ttl': `
ex:ParentShape a sh:NodeShape ;
    sh:targetClass ex:Parent ;
    sh:property [ sh:path ex:child ; sh:node ex:ChildShape ] .

ex:ChildShape a sh:NodeShape ;
    sh:property [ sh:path ex:childRequired ; sh:minCount 1 ] .
`,
    });

    const result = validateTurtle(
      `${PREFIXES}
      ex:parent a ex:Parent .
      ex:orphan a ex:ChildType .
      `,
      shapes.store,
      shapes.shapeFiles,
      'test.ttl',
    );

    // ex:orphan is not the object of ex:child, so nothing hands it to a shape.
    expect(result.coverage.unshapedSubjects.map((s) => s.uri)).toEqual([
      'http://example.org/orphan',
    ]);
  });
});

describe('shape coverage: sh:targetSubjectsOf and sh:targetObjectsOf', () => {
  it('counts nodes selected by predicate-based targets as checked', () => {
    const shapes = withShapes({
      'example.shapes.ttl': `
ex:SubjShape a sh:NodeShape ;
    sh:targetSubjectsOf ex:emits ;
    sh:property [ sh:path ex:required ; sh:minCount 1 ] .

ex:ObjShape a sh:NodeShape ;
    sh:targetObjectsOf ex:emits ;
    sh:property [ sh:path ex:alsoRequired ; sh:minCount 1 ] .
`,
    });

    const result = validateTurtle(
      `${PREFIXES}
      ex:src a ex:AnyType ; ex:emits ex:dst .
      ex:dst a ex:OtherType .
      `,
      shapes.store,
      shapes.shapeFiles,
      'test.ttl',
    );

    // Neither type is a sh:targetClass anywhere; both are still validated.
    expect(result.coverage.checkedSubjects).toBe(2);
    expect(result.coverage.unshapedSubjects).toHaveLength(0);
  });
});

describe('shapesUsed reports shapes that fired, not prefixes present', () => {
  const TWO_FILES = {
    'alpha.shapes.ttl': `
ex:AlphaShape a sh:NodeShape ;
    sh:targetClass ex:Alpha ;
    sh:property [ sh:path ex:required ; sh:minCount 1 ] .
`,
    'beta.shapes.ttl': `
ex:BetaShape a sh:NodeShape ;
    sh:targetClass ex:Beta ;
    sh:property [ sh:path ex:required ; sh:minCount 1 ] .
`,
  };

  it('names only the shape file whose shape selected a node', () => {
    const shapes = withShapes(TWO_FILES);
    const result = validateTurtle(
      `${PREFIXES}ex:a a ex:Alpha ; ex:required "x" .`,
      shapes.store,
      shapes.shapeFiles,
      'test.ttl',
    );
    expect(result.shapesUsed).toEqual(['alpha.shapes.ttl']);
    expect(result.shapesFired).toEqual(['AlphaShape']);
  });

  it('names no shape file when a file uses a vocabulary but matches no target', () => {
    const shapes = withShapes(TWO_FILES);
    // Every term here is in the ex: namespace the shapes are written in, and
    // the ex: prefix is declared. Prefix-based reporting names both files; only
    // target-based reporting correctly names none.
    const result = validateTurtle(
      `${PREFIXES}ex:c a ex:Gamma ; ex:required "x" .`,
      shapes.store,
      shapes.shapeFiles,
      'test.ttl',
    );
    expect(result.shapesUsed).toEqual([]);
    expect(result.shapesFired).toEqual([]);
    expect(result.coverage.checkedSubjects).toBe(0);
    expect(result.coverage.totalSubjects).toBe(1);
  });

  it('names both shape files when both fire', () => {
    const shapes = withShapes(TWO_FILES);
    const result = validateTurtle(
      `${PREFIXES}
      ex:a a ex:Alpha ; ex:required "x" .
      ex:b a ex:Beta ; ex:required "y" .
      `,
      shapes.store,
      shapes.shapeFiles,
      'test.ttl',
    );
    expect(result.shapesUsed.sort()).toEqual(['alpha.shapes.ttl', 'beta.shapes.ttl']);
    expect(result.shapesFired).toEqual(['AlphaShape', 'BetaShape']);
  });
});

describe('shape coverage is deterministic and input-sensitive', () => {
  const shapes = () => withShapes({ 'example.shapes.ttl': SUPER_SHAPE });

  it('produces identical coverage for the same input across separate loads', () => {
    const data = `${PREFIXES}
      ex:a a ex:Super ; ex:required "x" .
      ex:b a ex:Unrelated .
      ex:c a ex:AlsoUnrelated .
    `;
    const first = shapes();
    const second = shapes();
    const a = validateTurtle(data, first.store, first.shapeFiles, 'test.ttl');
    const b = validateTurtle(data, second.store, second.shapeFiles, 'test.ttl');

    // Pin the content before comparing. Two absent values compare equal, so a
    // bare a-equals-b assertion would pass just as happily with no coverage
    // computed at all.
    expect(a.coverage.totalSubjects).toBe(3);
    expect(a.coverage.checkedSubjects).toBe(1);
    expect(a.coverage.unshapedTypes).toHaveLength(2);
    expect(a.shapesUsed).toEqual(['example.shapes.ttl']);

    expect(JSON.stringify(a.coverage)).toBe(JSON.stringify(b.coverage));
    expect(a.shapesUsed).toEqual(b.shapesUsed);
  });

  it('produces different coverage for genuinely different inputs', () => {
    const loaded = shapes();
    const one = validateTurtle(
      `${PREFIXES}ex:a a ex:Super ; ex:required "x" .`,
      loaded.store,
      loaded.shapeFiles,
      'test.ttl',
    );
    const two = validateTurtle(
      `${PREFIXES}ex:b a ex:Unrelated . ex:c a ex:Unrelated .`,
      loaded.store,
      loaded.shapeFiles,
      'test.ttl',
    );
    expect(one.coverage).not.toEqual(two.coverage);
    expect(one.coverage.checkedSubjects).toBe(1);
    expect(two.coverage.checkedSubjects).toBe(0);
    expect(two.coverage.totalSubjects).toBe(2);
  });
});
