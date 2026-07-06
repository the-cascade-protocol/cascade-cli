/**
 * Regression tests for the `pod extract` entity-type -> Cascade RDF class map.
 *
 * The cascade-agent /extract service (`@the-cascade-protocol/agent`,
 * services/document-intelligence.d.ts) emits an `ExtractedEntity.type` from
 * this union:
 *
 *   'medication' | 'condition' | 'lab' | 'socialHistory' | 'vital'
 *     | 'allergy' | 'immunization' | 'procedure'
 *
 * ENTITY_TYPE_MAP originally keyed on 'labresult'/'vitalsign' and had no
 * 'socialhistory' key, so 'lab', 'vital' and 'socialHistory' all missed the
 * table and fell through to the `?? 'clinical:Condition'` default -- three
 * different clinical entities silently typed as conditions. These tests pin
 * every union member to a real, explicitly-mapped clinical class so the whole
 * fall-through bug class cannot recur.
 */

import { describe, it, expect } from 'vitest';
import { entityRdfType, ENTITY_TYPE_MAP } from '../src/commands/pod/extract.js';

// The exact ExtractedEntity.type union the agent emits, with the correct
// clinical class for each (verified against src/shapes/clinical.ttl and
// clinical.shapes.ttl):
//   clinical:LabResult          (clinical.ttl:107, LabResultShape)
//   clinical:VitalSign          (clinical.ttl:131, VitalSignShape)
//   clinical:SocialHistoryRecord(clinical.ttl:1592, EHR-extracted C-CDA social history)
const AGENT_TYPE_TO_CLASS: Record<string, string> = {
  medication: 'clinical:Medication',
  condition: 'clinical:Condition',
  lab: 'clinical:LabResult',
  socialHistory: 'clinical:SocialHistoryRecord',
  vital: 'clinical:VitalSign',
  allergy: 'clinical:Allergy',
  immunization: 'clinical:Immunization',
  procedure: 'clinical:Procedure',
};

const DEFAULT_FALLBACK = 'clinical:Condition';

describe('entityRdfType (pod extract entity-type mapping)', () => {
  describe('every agent ExtractedEntity.type member maps to a real, explicit class', () => {
    for (const [agentType, expectedClass] of Object.entries(AGENT_TYPE_TO_CLASS)) {
      it(`'${agentType}' -> ${expectedClass}`, () => {
        // Resolves to the expected clinical class...
        expect(entityRdfType(agentType)).toBe(expectedClass);
        // ...and via an EXPLICIT map key, never the clinical:Condition fallback.
        // (condition legitimately maps to clinical:Condition, but as an explicit
        // key, so the key-presence check still holds.)
        expect(
          Object.prototype.hasOwnProperty.call(ENTITY_TYPE_MAP, agentType.toLowerCase()),
          `'${agentType}' must have an explicit ENTITY_TYPE_MAP key, not rely on the fallback`,
        ).toBe(true);
        // Every mapped class is a clinical: domain class.
        expect(entityRdfType(agentType).startsWith('clinical:')).toBe(true);
      });
    }
  });

  it("no non-condition agent type resolves to the clinical:Condition fallback", () => {
    for (const agentType of Object.keys(AGENT_TYPE_TO_CLASS)) {
      if (agentType === 'condition') continue;
      expect(entityRdfType(agentType)).not.toBe(DEFAULT_FALLBACK);
    }
  });

  it("maps the agent's 'lab' entity type to clinical:LabResult, not clinical:Condition", () => {
    expect(entityRdfType('lab')).toBe('clinical:LabResult');
    expect(entityRdfType('lab')).not.toBe('clinical:Condition');
  });

  it("maps 'vital' to clinical:VitalSign and 'socialHistory' to clinical:SocialHistoryRecord", () => {
    expect(entityRdfType('vital')).toBe('clinical:VitalSign');
    expect(entityRdfType('socialHistory')).toBe('clinical:SocialHistoryRecord');
    expect(entityRdfType('vital')).not.toBe('clinical:Condition');
    expect(entityRdfType('socialHistory')).not.toBe('clinical:Condition');
  });

  it('is case-insensitive', () => {
    expect(entityRdfType('LAB')).toBe('clinical:LabResult');
    expect(entityRdfType('SocialHISTORY')).toBe('clinical:SocialHistoryRecord');
    expect(entityRdfType('Vital')).toBe('clinical:VitalSign');
  });

  it('still falls back to clinical:Condition for a genuinely unknown type', () => {
    expect(entityRdfType('not-a-real-type')).toBe('clinical:Condition');
  });
});
