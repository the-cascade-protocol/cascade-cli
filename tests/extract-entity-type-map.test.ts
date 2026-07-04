/**
 * Regression test for the `pod extract` entity-type -> Cascade RDF class map.
 *
 * The cascade-agent /extract service emits `type: 'lab'` for lab results
 * (see @the-cascade-protocol/agent `ExtractedEntity.type`). ENTITY_TYPE_MAP
 * only had a `labresult` key, so `'lab'` fell through to the clinical:Condition
 * default -- a lab result is not a condition. This proves `'lab'` now maps to
 * clinical:LabResult and no longer to clinical:Condition.
 */

import { describe, it, expect } from 'vitest';
import { entityRdfType } from '../src/commands/pod/extract.js';

describe('entityRdfType (pod extract entity-type mapping)', () => {
  it("maps the agent's 'lab' entity type to clinical:LabResult, not clinical:Condition", () => {
    expect(entityRdfType('lab')).toBe('clinical:LabResult');
    expect(entityRdfType('lab')).not.toBe('clinical:Condition');
  });

  it('is case-insensitive for lab results', () => {
    expect(entityRdfType('Lab')).toBe('clinical:LabResult');
    expect(entityRdfType('LAB')).toBe('clinical:LabResult');
  });

  it('still maps a real condition to clinical:Condition (unchanged)', () => {
    expect(entityRdfType('condition')).toBe('clinical:Condition');
  });

  it('leaves the other explicit mappings intact', () => {
    expect(entityRdfType('medication')).toBe('clinical:Medication');
    expect(entityRdfType('allergy')).toBe('clinical:Allergy');
    expect(entityRdfType('immunization')).toBe('clinical:Immunization');
    expect(entityRdfType('procedure')).toBe('clinical:Procedure');
  });
});
