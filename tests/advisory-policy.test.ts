/**
 * Tests for the CAP auto-apply policy engine (TASK-4.8).
 *
 * Acceptance:
 *   - Trusted (issuer × advisoryClass) → auto-apply.
 *   - Default (no matching policy) → queue.
 *   - D-QUALITY-TIER safety override:
 *       - ConsumerGrade variant → queue (even if policy matches)
 *       - requiresConfirmation true → queue (even if policy matches)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Store, DataFactory } from 'n3';
import {
  evaluatePolicy,
  loadPolicies,
  policiesFromStore,
  probeBoundQuality,
} from '../src/lib/advisory/policy.js';
import type { CapAst } from '../src/lib/advisory/types.js';

const { namedNode, literal, quad } = DataFactory;

const ISSUER = 'https://clingen.org/affiliation/40016';
const CLASS_RECLASS = 'https://ns.cascadeprotocol.org/advisory/v1#VariantReclassification';
const CLASS_DRUG = 'https://ns.cascadeprotocol.org/advisory/v1#DrugInteraction';

function fakeAdvisory(issuer: string, advisoryClass: string): CapAst {
  return {
    prefixes: {},
    envelope: {
      types: [],
      issuer,
      advisoryClass,
      profileVersion: '0.1',
      issuedAt: '2026-05-04T00:00:00Z',
      humanSummary: 'test',
      extra: [],
    },
    bind: null,
    adds: [],
  };
}

describe('evaluatePolicy — basic decisions', () => {
  it('returns auto-apply when (issuer × class) matches', () => {
    const policies = [
      { iri: 'urn:p:1', issuers: [ISSUER], advisoryClasses: [CLASS_RECLASS] },
    ];
    expect(evaluatePolicy(fakeAdvisory(ISSUER, CLASS_RECLASS), policies)).toBe('auto-apply');
  });

  it('returns queue when issuer matches but class does not', () => {
    const policies = [
      { iri: 'urn:p:1', issuers: [ISSUER], advisoryClasses: [CLASS_RECLASS] },
    ];
    expect(evaluatePolicy(fakeAdvisory(ISSUER, CLASS_DRUG), policies)).toBe('queue');
  });

  it('returns queue when class matches but issuer does not', () => {
    const policies = [
      { iri: 'urn:p:1', issuers: [ISSUER], advisoryClasses: [CLASS_RECLASS] },
    ];
    expect(
      evaluatePolicy(fakeAdvisory('https://other.example/', CLASS_RECLASS), policies),
    ).toBe('queue');
  });

  it('returns queue when no policies are configured (default)', () => {
    expect(evaluatePolicy(fakeAdvisory(ISSUER, CLASS_RECLASS), [])).toBe('queue');
  });

  it('returns queue when the advisory envelope is missing issuer', () => {
    const adv = fakeAdvisory('', CLASS_RECLASS);
    const policies = [
      { iri: 'urn:p:1', issuers: [ISSUER], advisoryClasses: [CLASS_RECLASS] },
    ];
    expect(evaluatePolicy(adv, policies)).toBe('queue');
  });

  it('matches against a multi-class policy', () => {
    const policies = [
      {
        iri: 'urn:p:1',
        issuers: [ISSUER],
        advisoryClasses: [CLASS_RECLASS, CLASS_DRUG],
      },
    ];
    expect(evaluatePolicy(fakeAdvisory(ISSUER, CLASS_DRUG), policies)).toBe('auto-apply');
  });
});

describe('evaluatePolicy — D-QUALITY-TIER safety override', () => {
  const policies = [
    { iri: 'urn:p:1', issuers: [ISSUER], advisoryClasses: [CLASS_RECLASS] },
  ];

  it('refuses auto-apply on ConsumerGrade variants (queues instead)', () => {
    const decision = evaluatePolicy(
      fakeAdvisory(ISSUER, CLASS_RECLASS),
      policies,
      { dataQualityTier: 'https://ns.cascadeprotocol.org/genomics/v1#ConsumerGrade' },
    );
    expect(decision).toBe('queue');
  });

  it('refuses auto-apply when requiresConfirmation is true', () => {
    const decision = evaluatePolicy(fakeAdvisory(ISSUER, CLASS_RECLASS), policies, {
      requiresConfirmation: true,
    });
    expect(decision).toBe('queue');
  });

  it('permits auto-apply on ClinicalGrade variants', () => {
    const decision = evaluatePolicy(fakeAdvisory(ISSUER, CLASS_RECLASS), policies, {
      dataQualityTier: 'https://ns.cascadeprotocol.org/genomics/v1#ClinicalGrade',
    });
    expect(decision).toBe('auto-apply');
  });

  it('permits auto-apply when requiresConfirmation is false', () => {
    const decision = evaluatePolicy(fakeAdvisory(ISSUER, CLASS_RECLASS), policies, {
      requiresConfirmation: false,
    });
    expect(decision).toBe('auto-apply');
  });
});

describe('policiesFromStore', () => {
  it('extracts policies from a Turtle-style store', () => {
    const s = new Store();
    s.addQuad(
      quad(
        namedNode('urn:pod:policy:1'),
        namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        namedNode('https://ns.cascadeprotocol.org/core/v1#AutoApplyPolicy'),
      ),
    );
    s.addQuad(
      quad(
        namedNode('urn:pod:policy:1'),
        namedNode('https://ns.cascadeprotocol.org/core/v1#trustsIssuer'),
        namedNode(ISSUER),
      ),
    );
    s.addQuad(
      quad(
        namedNode('urn:pod:policy:1'),
        namedNode('https://ns.cascadeprotocol.org/core/v1#trustsAdvisoryClass'),
        namedNode(CLASS_RECLASS),
      ),
    );
    s.addQuad(
      quad(
        namedNode('urn:pod:policy:1'),
        namedNode('https://ns.cascadeprotocol.org/core/v1#trustsAdvisoryClass'),
        namedNode(CLASS_DRUG),
      ),
    );

    const policies = policiesFromStore(s);
    expect(policies.length).toBe(1);
    expect(policies[0]!.issuers).toEqual([ISSUER]);
    expect(policies[0]!.advisoryClasses.sort()).toEqual([CLASS_DRUG, CLASS_RECLASS]);
  });

  it('returns empty array when the store has no policies', () => {
    expect(policiesFromStore(new Store())).toEqual([]);
  });
});

describe('loadPolicies', () => {
  let podDir: string;
  beforeEach(() => {
    podDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-policy-test-'));
  });
  afterEach(() => {
    fs.rmSync(podDir, { recursive: true, force: true });
  });

  it('returns [] when the policies file does not exist', () => {
    expect(loadPolicies(podDir)).toEqual([]);
  });

  it('loads policies from <pod>/policies/auto-apply.ttl', () => {
    const ttl = `
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix advisory: <https://ns.cascadeprotocol.org/advisory/v1#> .

<urn:pod:policy:1> a cascade:AutoApplyPolicy ;
    cascade:trustsIssuer <${ISSUER}> ;
    cascade:trustsAdvisoryClass advisory:VariantReclassification .
`;
    fs.mkdirSync(path.join(podDir, 'policies'), { recursive: true });
    fs.writeFileSync(path.join(podDir, 'policies', 'auto-apply.ttl'), ttl, 'utf8');

    const policies = loadPolicies(podDir);
    expect(policies.length).toBe(1);
    expect(policies[0]!.issuers).toEqual([ISSUER]);
    expect(policies[0]!.advisoryClasses).toEqual([CLASS_RECLASS]);
  });

  it('returns [] on a malformed Turtle file', () => {
    fs.mkdirSync(path.join(podDir, 'policies'), { recursive: true });
    fs.writeFileSync(
      path.join(podDir, 'policies', 'auto-apply.ttl'),
      'not valid turtle :::: ',
      'utf8',
    );
    expect(loadPolicies(podDir)).toEqual([]);
  });
});

describe('probeBoundQuality', () => {
  it('reads dataQualityTier from a pod store', () => {
    const s = new Store();
    s.addQuad(
      quad(
        namedNode('urn:pod:variant:1'),
        namedNode('https://ns.cascadeprotocol.org/genomics/v1#dataQualityTier'),
        namedNode('https://ns.cascadeprotocol.org/genomics/v1#ConsumerGrade'),
      ),
    );
    expect(probeBoundQuality(s, 'urn:pod:variant:1').dataQualityTier).toBe(
      'https://ns.cascadeprotocol.org/genomics/v1#ConsumerGrade',
    );
  });

  it('reads requiresConfirmation true from a pod store', () => {
    const s = new Store();
    s.addQuad(
      quad(
        namedNode('urn:pod:variant:1'),
        namedNode('https://ns.cascadeprotocol.org/genomics/v1#requiresConfirmation'),
        literal('true'),
      ),
    );
    expect(probeBoundQuality(s, 'urn:pod:variant:1').requiresConfirmation).toBe(true);
  });

  it('returns an empty object for unknown subjects', () => {
    expect(probeBoundQuality(new Store(), 'urn:pod:nothing')).toEqual({});
  });
});
