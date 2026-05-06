/**
 * Tests for phenopacket family resource → genomics:Pedigree (TASK-2B.6).
 *
 * Acceptance: trio (proband + MOTHER + FATHER) preserves Proband / MTH /
 * FTH roles. Sibling rows resolve to SIS / BRO when shared parentage is
 * present.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ImportContext } from '../src/lib/import-types.js';
import { parsePedigree } from '../src/lib/phenopacket-converter/pedigree.js';
import { convertPhenopacket } from '../src/lib/phenopacket-converter/index.js';
import { GENOMICS_NS } from '../src/lib/phenopacket-converter/types.js';
import { NS } from '../src/lib/fhir-converter/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(__dirname, '../../conformance/fixtures/genomics/phenopackets');

const ctx: ImportContext = {
  inputPath: '<test>',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: {},
  sourceSystem: 'phenopacket-test',
};

function findQuad(quads: any[], pred: string): string | undefined {
  return quads.find((q) => q.predicate.value === pred)?.object.value;
}

function objectsForPredicate(quads: any[], pred: string): string[] {
  return quads.filter((q) => q.predicate.value === pred).map((q) => q.object.value);
}

describe('parsePedigree — trio', () => {
  const trioFamily = {
    id: 'fam-1',
    proband: { subject: { id: 'PROBAND', sex: 'MALE' } },
    pedigree: {
      persons: [
        {
          individualId: 'PROBAND',
          paternalId: 'FATHER',
          maternalId: 'MOTHER',
          sex: 'MALE',
          affectedStatus: 'AFFECTED',
        },
        { individualId: 'MOTHER', sex: 'FEMALE', affectedStatus: 'UNAFFECTED' },
        { individualId: 'FATHER', sex: 'MALE', affectedStatus: 'UNAFFECTED' },
      ],
    },
  };

  it('emits 1 Pedigree + 3 PedigreeMember records', () => {
    const out = parsePedigree(trioFamily, new Map(), ctx);
    expect(out.records.filter((r) => r.cascadeType === 'genomics:Pedigree')).toHaveLength(1);
    expect(out.records.filter((r) => r.cascadeType === 'genomics:PedigreeMember')).toHaveLength(3);
  });

  it('assigns Proband / MTH / FTH roles', () => {
    const out = parsePedigree(trioFamily, new Map(), ctx);
    const members = out.records.filter((r) => r.cascadeType === 'genomics:PedigreeMember');
    const byId = new Map(members.map((m) => [m.sourceId, m]));
    expect(findQuad(byId.get('PROBAND')!.quads, GENOMICS_NS + 'relativeRole')).toBe(
      GENOMICS_NS + 'Proband',
    );
    expect(findQuad(byId.get('MOTHER')!.quads, GENOMICS_NS + 'relativeRole')).toBe(
      GENOMICS_NS + 'MTH',
    );
    expect(findQuad(byId.get('FATHER')!.quads, GENOMICS_NS + 'relativeRole')).toBe(
      GENOMICS_NS + 'FTH',
    );
  });

  it('records biological sex for each member', () => {
    const out = parsePedigree(trioFamily, new Map(), ctx);
    const members = out.records.filter((r) => r.cascadeType === 'genomics:PedigreeMember');
    const sexes = members
      .map((m) => `${m.sourceId}:${findQuad(m.quads, GENOMICS_NS + 'relativeSex')}`)
      .sort();
    expect(sexes).toEqual(
      ['FATHER:male', 'MOTHER:female', 'PROBAND:male'].sort(),
    );
  });

  it('Pedigree.proband + hasMember references all 3 members', () => {
    const out = parsePedigree(trioFamily, new Map(), ctx);
    const ped = out.records.find((r) => r.cascadeType === 'genomics:Pedigree')!;
    expect(objectsForPredicate(ped.quads, GENOMICS_NS + 'proband')).toHaveLength(1);
    expect(objectsForPredicate(ped.quads, GENOMICS_NS + 'hasMember')).toHaveLength(3);
  });

  it('records affectedStatus + emits info gaps', () => {
    const out = parsePedigree(trioFamily, new Map(), ctx);
    const proband = out.records.find((r) => r.sourceId === 'PROBAND')!;
    expect(findQuad(proband.quads, NS.cascade + 'affectedStatus')).toBe('affected');
    expect(out.gaps.some((g) => g.severity === 'info' && g.sourceField.endsWith('.affectedStatus'))).toBe(true);
  });

  it('links members to patient profiles when subjectIris is populated', () => {
    const subjectIris = new Map<string, string>([
      ['PROBAND', 'urn:uuid:test-proband'],
      ['MOTHER', 'urn:uuid:test-mother'],
    ]);
    const out = parsePedigree(trioFamily, subjectIris, ctx);
    const proband = out.records.find((r) => r.sourceId === 'PROBAND')!;
    expect(findQuad(proband.quads, NS.cascade + 'aboutPatient')).toBe('urn:uuid:test-proband');
  });
});

describe('parsePedigree — sibling inference', () => {
  const familyWithSibs = {
    id: 'fam-2',
    proband: { subject: { id: 'CHILD-A' } },
    pedigree: {
      persons: [
        { individualId: 'CHILD-A', paternalId: 'FATHER', maternalId: 'MOTHER', sex: 'MALE' },
        { individualId: 'CHILD-B', paternalId: 'FATHER', maternalId: 'MOTHER', sex: 'FEMALE' },
        { individualId: 'CHILD-C', paternalId: 'FATHER', maternalId: 'MOTHER', sex: 'MALE' },
        { individualId: 'MOTHER', sex: 'FEMALE' },
        { individualId: 'FATHER', sex: 'MALE' },
      ],
    },
  };

  it('infers SIS for full-sibling female and BRO for full-sibling male', () => {
    const out = parsePedigree(familyWithSibs, new Map(), ctx);
    const byId = new Map(
      out.records
        .filter((r) => r.cascadeType === 'genomics:PedigreeMember')
        .map((m) => [m.sourceId, m]),
    );
    expect(findQuad(byId.get('CHILD-B')!.quads, GENOMICS_NS + 'relativeRole')).toBe(
      GENOMICS_NS + 'SIS',
    );
    expect(findQuad(byId.get('CHILD-C')!.quads, GENOMICS_NS + 'relativeRole')).toBe(
      GENOMICS_NS + 'BRO',
    );
  });
});

describe('parsePedigree — no pedigree.persons[]', () => {
  it('returns empty records + info gap', () => {
    const out = parsePedigree({ id: 'fam', proband: { subject: { id: 's' } } }, new Map(), ctx);
    expect(out.records).toHaveLength(0);
    expect(out.gaps.some((g) => g.sourceField.endsWith('persons'))).toBe(true);
  });
});

describe('convertPhenopacket — family integration (v2-family fixture)', () => {
  it('produces 1 Pedigree + 3 PedigreeMember + 3 PatientProfile records', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'v2-family.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const ped = result.records.filter((r) => r.cascadeType === 'genomics:Pedigree');
    const members = result.records.filter((r) => r.cascadeType === 'genomics:PedigreeMember');
    const patients = result.records.filter((r) => r.cascadeType === 'cascade:PatientProfile');
    expect(ped).toHaveLength(1);
    expect(members).toHaveLength(3);
    expect(patients).toHaveLength(3);
  });

  it('proband / mother / father roles round-trip', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'v2-family.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const members = result.records.filter((r) => r.cascadeType === 'genomics:PedigreeMember');
    const roles = members
      .map((m) => findQuad(m.quads, GENOMICS_NS + 'relativeRole'))
      .filter(Boolean)
      .sort();
    expect(roles).toEqual([GENOMICS_NS + 'FTH', GENOMICS_NS + 'MTH', GENOMICS_NS + 'Proband'].sort());
  });
});
