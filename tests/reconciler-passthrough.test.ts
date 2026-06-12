/**
 * Regression tests: reconciliation must preserve subjects it cannot
 * reconcile (anything outside the reconciler's KNOWN_TYPES allowlist).
 *
 * Found 2026-06-11 building the cascade-dmt demo: importing C-CDA narrative
 * documents into a non-empty pod silently dropped the clinical:ClinicalDocument
 * records (and their cascade:requiresLLMExtraction flags) because the
 * reconciler only re-serialized the record types it understands.
 */
import { describe, it, expect } from 'vitest';
import { runReconciliation } from '../src/lib/reconciler.js';

const PREFIXES = `
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

const CONDITION_A = `${PREFIXES}
<urn:cascade:condition:g35a> a health:ConditionRecord ;
  cascade:sourceSystem "QuestLab" ;
  health:conditionName "Multiple sclerosis, relapsing-remitting" ;
  health:icd10Code <https://icd.who.int/icd-10-cm/G35.A> ;
  health:status "active" .
`;

// A narrative clinical document: NOT a reconcilable type, plus an untyped
// child section node referenced from it (also not reconcilable).
const NARRATIVE_DOC = `${PREFIXES}
<urn:cascade:document:mri-report> a clinical:ClinicalDocument ;
  cascade:sourceSystem "Cascade Imaging Center" ;
  clinical:documentTitle "MRI Brain w/wo Contrast" ;
  clinical:hasSection <urn:cascade:document:mri-report:findings> .

<urn:cascade:document:mri-report:findings>
  cascade:sectionCode "18782-3" ;
  cascade:requiresLLMExtraction "true" ;
  cascade:narrativeText "Two new T2 lesions in the right frontal white matter." .
`;

describe('reconciler passthrough of non-reconcilable subjects', () => {
  it('preserves ClinicalDocument records and their untyped section nodes through reconciliation', async () => {
    const result = await runReconciliation([
      { content: CONDITION_A, systemName: 'existing-pod' },
      { content: NARRATIVE_DOC, systemName: 'Cascade Imaging Center' },
    ]);

    // The reconcilable record still reconciles.
    expect(result.turtle).toContain('ConditionRecord');
    expect(result.report.summary.totalInputRecords).toBe(1);

    // The narrative document survives verbatim.
    expect(result.turtle).toContain('ClinicalDocument');
    expect(result.turtle).toContain('requiresLLMExtraction');
    expect(result.turtle).toContain('Two new T2 lesions');
    expect(result.turtle).toContain('18782-3');

    // Two passthrough subjects: the document and its section node.
    expect(result.report.summary.passthroughSubjects).toBe(2);
  });

  it('does not duplicate passthrough quads when the same document is fed from existing pod and re-import', async () => {
    const result = await runReconciliation([
      { content: NARRATIVE_DOC, systemName: 'existing-pod' },
      { content: NARRATIVE_DOC, systemName: 'Cascade Imaging Center' },
      { content: CONDITION_A, systemName: 'QuestLab' },
    ]);

    const flagCount = (result.turtle.match(/requiresLLMExtraction/g) ?? []).length;
    expect(flagCount).toBe(1);
    expect(result.report.summary.passthroughSubjects).toBe(2);
  });

  it('reports zero passthrough subjects when all inputs are reconcilable', async () => {
    const conditionB = CONDITION_A.replace('QuestLab', 'Prior Neurology Note');
    const result = await runReconciliation([
      { content: CONDITION_A, systemName: 'QuestLab' },
      { content: conditionB, systemName: 'Prior Neurology Note' },
    ]);

    expect(result.report.summary.passthroughSubjects).toBe(0);
  });
});
