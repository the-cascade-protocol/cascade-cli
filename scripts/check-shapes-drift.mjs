#!/usr/bin/env node
/**
 * check-shapes-drift.mjs — fail when `src/shapes/` no longer matches `spec`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/shapes/` is a vendored copy of every ontology and shapes file authored in
 * `spec`, placed here by `scripts/sync-shapes-from-spec.sh`. Until this script
 * existed nothing checked that the copy was current. `tests/shapes-sync.test.ts`
 * checks the bundle is internally consistent — every shape has its ontology,
 * every `sh:targetClass` resolves — which is a different question and stays
 * green while the whole bundle is uniformly stale.
 *
 * The cost of that gap was not staleness, it was ambiguity. `genomics.shapes.ttl`
 * spent roughly three weeks behind `spec` carrying `sh:class genomics:Variant` on
 * `genomics:hasComponent`. SHACL resolves `sh:class` over instances in the DATA
 * graph, so a component typed `genomics:CopyNumberVariant` (a subclass of
 * `genomics:Variant`) was rejected by a validator performing no entailment and
 * accepted by one that does. `spec` had already replaced that with an enumerated
 * `sh:or` per `validation/index.md` rule S3, and the correction never reached
 * anyone installing the package. Two conformant validators disagreeing about the
 * same star allele is the worst answer a specification can give.
 *
 * THE INDEPENDENCE RULE, WHICH IS THE WHOLE POINT
 * -----------------------------------------------
 * This script discovers what `spec` publishes by WALKING `spec/ontologies/`. It
 * does not read, source, import or otherwise consult
 * `scripts/sync-shapes-from-spec.sh`, and it shares no vocabulary list with it.
 *
 * That is deliberate and it is not stylistic. A checker that asks the generator
 * what the generator believes it produced can only ever confirm the generator is
 * self-consistent. The reference case is a sibling repository's documentation
 * generator: its self-report was green while five of six ratified ontologies
 * were missing from its output, and it exited 0. The
 * same shape produced this repository's own earlier bug — the sync script kept
 * one list for shapes and another for ontologies, the second never grew, and
 * `src/shapes/health.ttl` had never been synced at all.
 *
 * So the two lists here are discovered, not declared:
 *   - what `spec` publishes  -> readdir over `spec/ontologies/<vocab>/<version>/`
 *   - what this repo vendors -> readdir over `src/shapes/`
 * and drift is any disagreement between them, in either direction.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   1. Every `.ttl` published under `spec/ontologies/` is vendored here, unless
 *      its vocabulary is in NOT_VENDORED below, which is an exact pinned set.
 *   2. Every `.ttl` vendored here comes from a file `spec` still publishes.
 *   3. Each pair is byte-identical. Byte equality is the assertion because it
 *      holds today for all 20 files: the sync is a plain `cp`, nothing rewrites
 *      a header, so there is no by-design difference to exempt. If one is ever
 *      introduced, weaken THIS assertion to a graph comparison for THAT file and
 *      say why, rather than adding a general escape hatch.
 *   4. Both copies parse as Turtle. A file that differs is reported as drift; a
 *      file that does not parse is reported separately, because a bundle the
 *      validator cannot load fails differently from one that is merely stale.
 *   5. `VOCAB_VERSIONS` here matches `spec/VOCAB_VERSIONS` row for row, and each
 *      row's version is the `owl:versionInfo` the vendored ontology actually
 *      declares. A version bumped in `spec` with no sync fails at (3); a row
 *      edited here with no sync fails at (5).
 *
 * NOT FINDING ANYTHING IS NOT A PASS
 * ----------------------------------
 * The floors below fail the run if the walk turns up implausibly little. A
 * mis-rooted or symlink-blocked walk otherwise reports "0 files differ", which
 * reads exactly like success. That is how the generator above shipped.
 *
 * EXIT CODES
 * ----------
 *   0  vendored copy matches spec
 *   1  drift found (this is the gate firing)
 *   2  cannot check — no spec checkout, unreadable input, or a vacuous walk.
 *      Never conflated with 0.
 *
 * USAGE
 * -----
 *   node scripts/check-shapes-drift.mjs [--spec <dir>]
 *   CASCADE_SPEC_DIR=/path/to/spec node scripts/check-shapes-drift.mjs
 *
 * Resolution order: --spec, then CASCADE_SPEC_DIR, then the sibling `../spec`.
 * From a git worktree the sibling will not resolve; pass --spec or the env var.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED_DIR = path.join(REPO, 'src', 'shapes');

/**
 * Vocabularies published by `spec` that this repository deliberately does not
 * bundle, with the reason. Pinned as an exact set, not a pattern: a new
 * vocabulary appearing in `spec` should surface here as a decision someone makes
 * once, not be waved through by a rule that happens to match its name.
 *
 * `diabetes` publishes `diabetes.ttl` and no `diabetes.shapes.ttl`. Bundling an
 * ontology with no shapes would break the pairing invariant that
 * `tests/shapes-sync.test.ts` asserts, so it stays out until `spec` ships shapes
 * for it. Until then `cascade validate` cannot constrain diabetes data at all:
 * with neither the ontology nor shapes bundled, a diabetes-typed record is
 * checked by nothing and reports conforming.
 */
const NOT_VENDORED = new Map([
  ['diabetes', 'spec publishes diabetes.ttl and no diabetes.shapes.ttl; bundling an ontology with no shapes would break the pairing invariant'],
]);

/**
 * Floors, set below the counts measured on 2026-08-20 (11 vocabulary
 * directories, 21 spec files, 20 vendored files) so ordinary vocabulary growth
 * never touches them. They exist to make an empty walk fail loudly.
 */
const MIN_SPEC_VOCAB_DIRS = 8;
const MIN_SPEC_FILES = 16;
const MIN_VENDORED_FILES = 16;

const OWL_ONTOLOGY = 'http://www.w3.org/2002/07/owl#Ontology';
const OWL_VERSION_INFO = 'http://www.w3.org/2002/07/owl#versionInfo';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function fail(message) {
  console.error(`\nCANNOT CHECK: ${message}`);
  console.error('Refusing to report "no drift" from a check that did not run.');
  process.exit(2);
}

function resolveSpecDir(argv) {
  const flagIndex = argv.indexOf('--spec');
  if (flagIndex !== -1) {
    const value = argv[flagIndex + 1];
    if (!value) fail('--spec was given with no directory after it.');
    return path.resolve(value);
  }
  if (process.env.CASCADE_SPEC_DIR) return path.resolve(process.env.CASCADE_SPEC_DIR);
  return path.resolve(REPO, '..', 'spec');
}

/**
 * `statSync` and not `withFileTypes`/`lstat`: the spec checkout is frequently
 * reached through a symlink (a sibling link, a worktree parent), and a Dirent
 * for a symlinked directory answers `isDirectory()` false. A walk that skips
 * symlinked entries finds nothing and exits 0, which is the exact silent-empty
 * failure this script exists to prevent.
 */
function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Independent walk of what `spec` publishes: every `*.ttl` two levels under
 * `ontologies/`, i.e. `ontologies/<vocab>/<version>/<file>.ttl`.
 *
 * Returns Map<basename, {vocab, version, absPath}> plus the directory count, so
 * a caller can tell "found nothing" from "found everything and it all matched".
 */
function walkSpecOntologies(specRoot) {
  const ontologies = path.join(specRoot, 'ontologies');
  if (!isDirectory(ontologies)) fail(`${ontologies} is not a directory.`);

  const files = new Map();
  const vocabDirs = [];
  const collisions = [];

  for (const vocab of fs.readdirSync(ontologies).sort()) {
    const vocabPath = path.join(ontologies, vocab);
    if (!isDirectory(vocabPath)) continue;
    vocabDirs.push(vocab);

    for (const version of fs.readdirSync(vocabPath).sort()) {
      const versionPath = path.join(vocabPath, version);
      if (!isDirectory(versionPath)) continue;

      for (const file of fs.readdirSync(versionPath).sort()) {
        if (!file.endsWith('.ttl')) continue;
        const entry = { vocab, version, absPath: path.join(versionPath, file) };
        const existing = files.get(file);
        if (existing) {
          // Two version directories publishing the same basename would make
          // "the vendored copy" ambiguous, and `src/shapes/` is flat so only one
          // could ever land. Report it rather than letting sort order decide.
          collisions.push(
            `${file}: ${existing.vocab}/${existing.version} and ${vocab}/${version}`,
          );
          continue;
        }
        files.set(file, entry);
      }
    }
  }

  return { files, vocabDirs, collisions };
}

function walkVendored(dir) {
  if (!isDirectory(dir)) fail(`${dir} is not a directory.`);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ttl'))
    .sort();
}

function parseVersionsFile(file) {
  const rows = new Map();
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, value] = trimmed.split('=');
    if (key && value) rows.set(key.trim(), value.trim());
  }
  return rows;
}

/** Parse errors are returned, not thrown: an unparseable file is a finding. */
function parseTurtle(absPath) {
  try {
    return { quads: new Parser().parse(fs.readFileSync(absPath, 'utf-8')), error: null };
  } catch (e) {
    return { quads: null, error: e.message };
  }
}

/**
 * Diagnostic only — the byte comparison above has already decided the verdict.
 * This exists so a failure message can say whether someone changed a rule or
 * only a comment. Blank node labels are collapsed rather than matched up, so
 * this is a heuristic and is reported as one; SHACL property shapes are almost
 * entirely blank nodes and true isomorphism checking is not worth carrying here.
 */
function characterizeDifference(specQuads, vendoredQuads) {
  const collapse = (quads) =>
    quads
      .map((q) =>
        [q.subject, q.predicate, q.object, q.graph]
          .map((t) => (t.termType === 'BlankNode' ? '_:b' : `${t.termType}:${t.value}`))
          .join(' '),
      )
      .sort()
      .join('\n');

  if (specQuads.length !== vendoredQuads.length) {
    return `${vendoredQuads.length} triples vendored against ${specQuads.length} in spec`;
  }
  if (collapse(specQuads) !== collapse(vendoredQuads)) {
    return `${specQuads.length} triples on both sides, but their content differs`;
  }
  return 'comments or formatting only, by a blank-node-collapsing comparison';
}

function firstDifferingLine(specPath, vendoredPath) {
  const a = fs.readFileSync(specPath, 'utf-8').split('\n');
  const b = fs.readFileSync(vendoredPath, 'utf-8').split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}\n        spec:     ${JSON.stringify(a[i] ?? '<end of file>')}\n        vendored: ${JSON.stringify(b[i] ?? '<end of file>')}`;
    }
  }
  return 'no differing line (trailing bytes only)';
}

function main() {
  const specRoot = resolveSpecDir(process.argv.slice(2));
  if (!isDirectory(specRoot)) {
    fail(
      `no spec checkout at ${specRoot}.\n` +
        '  Clone https://github.com/the-cascade-protocol/spec as a sibling of this\n' +
        '  repository, or pass --spec <dir>, or set CASCADE_SPEC_DIR.',
    );
  }

  console.log(`spec:     ${specRoot}`);
  console.log(`vendored: ${VENDORED_DIR}`);

  const { files: specFiles, vocabDirs, collisions } = walkSpecOntologies(specRoot);
  const vendoredFiles = walkVendored(VENDORED_DIR);

  console.log(
    `walked ${vocabDirs.length} vocabulary directories, ${specFiles.size} spec files, ` +
      `${vendoredFiles.length} vendored files`,
  );

  if (vocabDirs.length < MIN_SPEC_VOCAB_DIRS) {
    fail(
      `only ${vocabDirs.length} vocabulary directories under ${specRoot}/ontologies, ` +
        `expected at least ${MIN_SPEC_VOCAB_DIRS}. The walk found too little to be believed.`,
    );
  }
  if (specFiles.size < MIN_SPEC_FILES) {
    fail(
      `only ${specFiles.size} .ttl files under ${specRoot}/ontologies, expected at least ` +
        `${MIN_SPEC_FILES}. The walk found too little to be believed.`,
    );
  }
  if (vendoredFiles.length < MIN_VENDORED_FILES) {
    fail(
      `only ${vendoredFiles.length} .ttl files in ${VENDORED_DIR}, expected at least ` +
        `${MIN_VENDORED_FILES}.`,
    );
  }

  const problems = [];

  for (const c of collisions) {
    problems.push(`AMBIGUOUS  ${c}\n    Two spec version directories publish the same file name.`);
  }

  // (1) published by spec, absent here.
  for (const [name, entry] of [...specFiles].sort()) {
    if (vendoredFiles.includes(name)) continue;
    const reason = NOT_VENDORED.get(entry.vocab);
    if (reason) continue;
    problems.push(
      `MISSING    src/shapes/${name}\n` +
        `    spec publishes ontologies/${entry.vocab}/${entry.version}/${name} and this\n` +
        `    repository does not bundle it. If that is deliberate, add ${entry.vocab} to\n` +
        `    NOT_VENDORED in this script with the reason.`,
    );
  }

  // (1b) exempted, but the exemption has gone stale.
  for (const [vocab, reason] of NOT_VENDORED) {
    const stillUnpublished = ![...specFiles.values()].some((e) => e.vocab === vocab);
    const nowVendored = [...specFiles]
      .filter(([, e]) => e.vocab === vocab)
      .some(([name]) => vendoredFiles.includes(name));
    if (stillUnpublished) {
      problems.push(
        `STALE      NOT_VENDORED lists ${vocab}, which spec no longer publishes.\n` +
          `    Remove the entry. (${reason})`,
      );
    } else if (nowVendored) {
      problems.push(
        `STALE      NOT_VENDORED lists ${vocab}, but it IS bundled now.\n` +
          `    Remove the entry so the files are actually compared. (${reason})`,
      );
    }
  }

  // (2) bundled here, not published by spec.
  for (const name of vendoredFiles) {
    if (specFiles.has(name)) continue;
    problems.push(
      `ORPHAN     src/shapes/${name}\n` +
        `    No file of this name is published under spec/ontologies/. Vocabulary is\n` +
        `    authored in spec and nowhere else, so this file has no upstream.`,
    );
  }

  // (3)(4) byte comparison, and both sides parse.
  let compared = 0;
  for (const name of vendoredFiles) {
    const entry = specFiles.get(name);
    if (!entry) continue;
    const vendoredPath = path.join(VENDORED_DIR, name);

    const vendoredParse = parseTurtle(vendoredPath);
    if (vendoredParse.error) {
      problems.push(`UNPARSEABLE src/shapes/${name}\n    ${vendoredParse.error}`);
      continue;
    }
    const specParse = parseTurtle(entry.absPath);
    if (specParse.error) {
      problems.push(
        `UNPARSEABLE spec/ontologies/${entry.vocab}/${entry.version}/${name}\n    ${specParse.error}`,
      );
      continue;
    }

    compared++;
    const same = fs.readFileSync(entry.absPath).equals(fs.readFileSync(vendoredPath));
    if (!same) {
      problems.push(
        `DRIFTED    src/shapes/${name}\n` +
          `    against spec/ontologies/${entry.vocab}/${entry.version}/${name}\n` +
          `    difference: ${characterizeDifference(specParse.quads, vendoredParse.quads)}\n` +
          `    first at ${firstDifferingLine(entry.absPath, vendoredPath)}`,
      );
    }
  }

  // A run that compared nothing must not report success.
  if (compared < MIN_VENDORED_FILES) {
    fail(
      `only ${compared} file pairs were actually compared, expected at least ` +
        `${MIN_VENDORED_FILES}. Every assertion above would pass vacuously.`,
    );
  }

  // (5) VOCAB_VERSIONS, in both directions, against the bundled ontology.
  const specVersionsFile = path.join(specRoot, 'VOCAB_VERSIONS');
  const localVersionsFile = path.join(REPO, 'VOCAB_VERSIONS');
  if (!fs.existsSync(specVersionsFile)) fail(`${specVersionsFile} does not exist.`);
  const specVersions = parseVersionsFile(specVersionsFile);
  const localVersions = parseVersionsFile(localVersionsFile);
  if (specVersions.size === 0) fail(`${specVersionsFile} declares no vocabulary rows.`);

  for (const [vocab, specVersion] of [...specVersions].sort()) {
    const localVersion = localVersions.get(vocab);
    if (localVersion === undefined) {
      problems.push(
        `VERSION    VOCAB_VERSIONS has no row for ${vocab}; spec declares ${vocab}=${specVersion}.`,
      );
      continue;
    }
    if (localVersion !== specVersion) {
      problems.push(
        `VERSION    VOCAB_VERSIONS says ${vocab}=${localVersion}; spec says ${vocab}=${specVersion}.`,
      );
    }
  }
  for (const vocab of [...localVersions.keys()].sort()) {
    if (!specVersions.has(vocab)) {
      problems.push(
        `VERSION    VOCAB_VERSIONS declares ${vocab}, which spec/VOCAB_VERSIONS does not.`,
      );
    }
  }

  // The row has to be the version the bundled file declares, not just the
  // version spec agrees with — otherwise both files could say 2.7 while the
  // ontology on disk here is still 2.6.
  for (const [vocab, version] of [...localVersions].sort()) {
    const bundled = path.join(VENDORED_DIR, `${vocab}.ttl`);
    if (!fs.existsSync(bundled)) {
      problems.push(`VERSION    VOCAB_VERSIONS declares ${vocab} but src/shapes/${vocab}.ttl is absent.`);
      continue;
    }
    const parsed = parseTurtle(bundled);
    if (parsed.error) continue; // already reported as UNPARSEABLE
    const ontologyNodes = parsed.quads
      .filter((q) => q.predicate.value === RDF_TYPE && q.object.value === OWL_ONTOLOGY)
      .map((q) => q.subject.value);
    const declared = parsed.quads
      .filter(
        (q) => q.predicate.value === OWL_VERSION_INFO && ontologyNodes.includes(q.subject.value),
      )
      .map((q) => q.object.value);
    if (!declared.includes(version)) {
      problems.push(
        `VERSION    VOCAB_VERSIONS says ${vocab}=${version}, but src/shapes/${vocab}.ttl\n` +
          `    declares owl:versionInfo ${declared.length ? declared.join(', ') : '<none>'}.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  ${p}\n`);
    console.error('The vendored shapes are not the shapes spec publishes.');
    console.error('Re-sync:  sh scripts/sync-shapes-from-spec.sh');
    console.error('then update VOCAB_VERSIONS and CHANGELOG.md in the same change.');
    process.exit(1);
  }

  console.log(
    `\nOK: ${compared} files byte-identical to spec, ${localVersions.size} VOCAB_VERSIONS rows agree ` +
      'with spec and with the bundled ontologies.',
  );
}

main();
