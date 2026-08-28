/**
 * Encounter participation nodes get their IRIs from one door, and that door is
 * deterministic.
 *
 * WHY THIS SUITE EXISTS AT ALL
 * ----------------------------
 * This is the first structured SUB-NODE the FHIR converter mints — every other
 * subject it writes is a record whose IRI comes from the source's own id — and
 * a sub-node has no id of its own to key on. That is exactly the situation in
 * which this repository has, three separate times, minted an identity from
 * something that was not the record's content: a clock, a counter, a random
 * value, an array index. The consequence is the same every time and it is
 * silent: re-importing one document produces a second identity for each node,
 * so nothing reconciles and the pod grows on every sync.
 *
 * The cure that worked before was not fixing sites, it was a chokepoint.
 * `encounterParticipantUri` is the chokepoint; this file is the proof that it
 * holds, and `tests/identity-chokepoint.test.ts` is the fence that stops a
 * second way in from being added.
 *
 * WHAT IS PROVEN, IN ORDER OF STRENGTH
 * ------------------------------------
 *   1. The IRI is a function of the encounter IRI and the participation's own
 *      stated content, and of NOTHING else — proven positively (change a fact,
 *      the IRI moves) and negatively (change the array order or a non-emitted
 *      neighbouring element, the IRI does not).
 *   2. Re-conversion is idempotent, so a second import of the same source adds
 *      no subject. This is the property the re-import repair path rests
 *      on, checked here through `runReconciliation` rather than by inspecting
 *      converter output twice.
 *   3. Two SEPARATE PROCESSES, run from two DIFFERENT working directories,
 *      against the BUILT artifact in `dist/`, agree byte for byte. An
 *      in-process determinism check shares a module cache, a module-level
 *      random seed and one `process.cwd()`, so a defect keyed on any of those
 *      is invisible to it — which is precisely how the path-dependent VCF IRI
 *      defect stayed green for months.
 *
 * All fixtures are synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';

import { convertEncounter } from '../src/lib/fhir-converter/converters-clinical.js';
import { runReconciliation } from '../src/lib/reconciler.js';
import { NS, quadsToTurtle } from '../src/lib/fhir-converter/types.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(REPO, 'dist');
const HAVE_DIST = fs.existsSync(path.join(DIST, 'lib', 'fhir-converter', 'fhir-to-cascade.js'));

const RDF_TYPE = NS.rdf + 'type';
const PARTICIPANT_CLASS = NS.clinical + 'EncounterParticipant';
const PARTICIPANT_NAME = NS.clinical + 'participantName';

type Quadish = {
  subject: { value: string };
  predicate: { value: string };
  object: { value: string };
};
type Converted = { _quads: Quadish[] };

/**
 * The measured Epic shape: a referrer in slot 0, the treating attender with a
 * specialty extension in slot 1.
 */
function encounterResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: 'Encounter',
    id: 'enc-derm-1',
    status: 'finished',
    class: { system: 'urn:oid:1.2.840.114350.1.72.1.7.1', code: '5', display: 'Appointment' },
    identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.999.2.7.3.698084.8', value: '20100000001' }],
    participant: [
      {
        type: [{ text: 'referrer', coding: [{ code: 'REF', display: 'referrer' }] }],
        individual: { display: 'Lucia Marsh, MD' },
      },
      {
        type: [{ text: 'attender', coding: [{ code: 'ATND', display: 'attender' }] }],
        extension: [
          {
            url: 'https://vendor.example/fhir/StructureDefinition/participant-specialty',
            valueCodeableConcept: { text: 'Dermatology' },
          },
        ],
        individual: { display: 'Amara Okoye, MD' },
      },
    ],
    period: { start: '2025-04-01T16:00:00Z', end: '2025-04-01T16:40:00Z' },
    ...overrides,
  };
}

/** The participation node IRIs a conversion minted, sorted. */
function participantIris(resource: Record<string, unknown>): string[] {
  const result = convertEncounter(structuredClone(resource)) as Converted;
  return result._quads
    .filter((q) => q.predicate.value === RDF_TYPE && q.object.value === PARTICIPANT_CLASS)
    .map((q) => q.subject.value)
    .sort();
}

/** The IRI of the participation whose name is `name`. */
function iriOfNamed(resource: Record<string, unknown>, name: string): string | undefined {
  const result = convertEncounter(structuredClone(resource)) as Converted;
  return result._quads.find(
    (q) => q.predicate.value === PARTICIPANT_NAME && q.object.value === name,
  )?.subject.value;
}

// ---------------------------------------------------------------------------
// 1. A function of the content, and of nothing else
// ---------------------------------------------------------------------------

describe('the participation IRI is a pure function of (encounter IRI, participation content)', () => {
  it('two conversions of the same resource mint the same IRIs', () => {
    expect(participantIris(encounterResource())).toEqual(participantIris(encounterResource()));
  });

  it('the IRIs do not depend on ARRAY ORDER', () => {
    // The single most tempting wrong key. An index is a property of the
    // SERIALIZATION: FHIR does not promise participant[] order across two reads
    // of one resource, so an index-keyed IRI moves when a server reorders the
    // array and duplicates a node whose content never changed.
    const forward = encounterResource();
    const reversed = encounterResource({
      participant: [...(encounterResource().participant as unknown[])].reverse(),
    });
    expect(participantIris(reversed)).toEqual(participantIris(forward));
  });

  it('the IRIs do not depend on an unrelated element of the same encounter', () => {
    // The encounter's own IRI is keyed on `resource.id`, which does not move,
    // so changing a fact about the VISIT must not re-mint its PARTICIPATIONS.
    const withOtherFacility = encounterResource({
      location: [{ location: { display: 'SOMEWHERE ELSE' } }],
    });
    expect(participantIris(withOtherFacility)).toEqual(participantIris(encounterResource()));
  });

  it('changing the participation NAME moves that IRI and leaves the other alone', () => {
    const base = encounterResource();
    const renamed = encounterResource({
      participant: [
        (base.participant as any[])[0],
        { ...(base.participant as any[])[1], individual: { display: 'Someone Else, MD' } },
      ],
    });
    expect(iriOfNamed(renamed, 'Lucia Marsh, MD')).toBe(iriOfNamed(base, 'Lucia Marsh, MD'));
    expect(iriOfNamed(renamed, 'Someone Else, MD')).not.toBe(iriOfNamed(base, 'Amara Okoye, MD'));
  });

  it('changing the SPECIALTY moves the IRI, because it is a fact the node states', () => {
    // Stated as its own case because it is the invariant that makes the IRI
    // honest: every fact the node carries is in its key, so two nodes that
    // differ in any stated fact are two IRIs, and two nodes with one IRI are
    // identical in every stated fact.
    const other = encounterResource({
      participant: [
        (encounterResource().participant as any[])[0],
        {
          ...(encounterResource().participant as any[])[1],
          extension: [
            {
              url: 'https://vendor.example/fhir/StructureDefinition/participant-specialty',
              valueCodeableConcept: { text: 'Sleep Medicine' },
            },
          ],
        },
      ],
    });
    expect(iriOfNamed(other, 'Amara Okoye, MD')).not.toBe(
      iriOfNamed(encounterResource(), 'Amara Okoye, MD'),
    );
  });

  it('the same participation at a DIFFERENT encounter is a different node', () => {
    // A participation belongs to a visit. "Amara Okoye, MD, attender" is not one
    // thing shared between two visits; it is two participations, and merging
    // them would attach one visit's care team to another.
    const otherVisit = encounterResource({ id: 'enc-derm-2' });
    expect(iriOfNamed(otherVisit, 'Amara Okoye, MD')).not.toBe(
      iriOfNamed(encounterResource(), 'Amara Okoye, MD'),
    );
  });

  it('two participations that state identical facts collapse to one node', () => {
    // Chosen, not tolerated. Nothing in the record distinguishes them, and this
    // codebase's rule for that case is to merge what nothing can tell apart
    // rather than mint a second IRI per import — a duplicate set that grows
    // forever and never announces itself.
    const twice = encounterResource({
      participant: [
        { type: [{ text: 'attender' }], individual: { display: 'Amara Okoye, MD' } },
        { type: [{ text: 'attender' }], individual: { display: 'Amara Okoye, MD' } },
      ],
    });
    expect(participantIris(twice)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Re-import adds nothing
// ---------------------------------------------------------------------------

describe('re-import is idempotent: the 3.268 repair path stays safe', () => {
  async function importTwice(): Promise<{ subjects: Set<string>; conflicts: number }> {
    const converted = convertEncounter(encounterResource()) as Converted;
    const turtle = await quadsToTurtle(converted._quads as never);
    const provenance = `@prefix cascade: <${NS.cascade}> .\n`;

    // Pass 1: a fresh pod. Pass 2: the pod's own content fed back in alongside a
    // re-conversion of the same source, which is exactly what
    // `pod import --reconcile-existing` does on a repair run.
    const first = await runReconciliation([
      { content: provenance + turtle, systemName: 'northgate-fhir' },
    ]);
    const second = await runReconciliation([
      { content: first.turtle, systemName: 'northgate-fhir', existingPod: true },
      { content: provenance + turtle, systemName: 'northgate-fhir' },
    ]);

    const quads = new Parser().parse(second.turtle);
    return {
      subjects: new Set(quads.map((q) => q.subject.value)),
      conflicts: second.conflicts?.length ?? 0,
    };
  }

  it('a second import of the same source produces no new subject and no conflict', async () => {
    const converted = convertEncounter(encounterResource()) as Converted;
    const turtle = await quadsToTurtle(converted._quads as never);
    const once = await runReconciliation([
      { content: `@prefix cascade: <${NS.cascade}> .\n` + turtle, systemName: 'northgate-fhir' },
    ]);
    const onceSubjects = new Set(new Parser().parse(once.turtle).map((q) => q.subject.value));

    const twice = await importTwice();

    // Byte-stable: not merely the same COUNT of subjects, the same subjects.
    expect([...twice.subjects].sort()).toEqual([...onceSubjects].sort());
    expect(twice.conflicts).toBe(0);
  });

  it('both participation nodes survive the round trip', async () => {
    // Guards the vacuous pass: "no growth" is trivially true of an output that
    // dropped the nodes entirely, and a participation node is not a reconcilable
    // record type, so it travels the passthrough path.
    const twice = await importTwice();
    const participants = [...twice.subjects].filter((s) =>
      participantIris(encounterResource()).includes(s),
    );
    expect(participants).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Across processes and directories, against the built artifact
// ---------------------------------------------------------------------------

const SCRIPT = `
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';

const dist = process.env.CASCADE_DIST;
const { convertEncounter } = await import(
  pathToFileURL(path.join(dist, 'lib/fhir-converter/converters-clinical.js')).href
);

const resource = JSON.parse(process.env.CASCADE_ENCOUNTER);
const result = convertEncounter(resource);
const PARTICIPANT = 'https://ns.cascadeprotocol.org/clinical/v1#EncounterParticipant';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

process.stdout.write(JSON.stringify({
  iris: result._quads
    .filter((q) => q.predicate.value === RDF_TYPE && q.object.value === PARTICIPANT)
    .map((q) => q.subject.value)
    .sort(),
  cwd: process.cwd(),
}));
`;

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

let scriptPath = '';
function mintInFreshProcess(cwd: string): { iris: string[]; cwd: string } {
  if (!scriptPath) {
    scriptPath = path.join(tempDir('cascade-participant-script-'), 'mint.mjs');
    fs.writeFileSync(scriptPath, SCRIPT);
  }
  const stdout = execFileSync(process.execPath, [scriptPath], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CASCADE_DIST: DIST,
      CASCADE_ENCOUNTER: JSON.stringify(encounterResource()),
    },
  });
  return JSON.parse(stdout) as { iris: string[]; cwd: string };
}

describe.skipIf(!HAVE_DIST)('participation IRIs survive the process and the directory', () => {
  it('two fresh processes in two different directories mint byte-identical IRIs', () => {
    const a = mintInFreshProcess(tempDir('cascade-participant-a-'));
    const b = mintInFreshProcess(tempDir('cascade-participant-b-'));

    // The directories must actually differ, or the comparison proves nothing.
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.iris).toHaveLength(2);
    expect(a.iris).toEqual(b.iris);
  });

  it('a fresh process agrees with this one, so the built artifact matches the source', () => {
    const fresh = mintInFreshProcess(tempDir('cascade-participant-c-'));
    expect(fresh.iris).toEqual(participantIris(encounterResource()));
  });
});
