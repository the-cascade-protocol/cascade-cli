/**
 * Regression tests: ClinicalDocument URIs must be deterministic across
 * conversion runs when the C-CDA carries a document id.
 *
 * Found 2026-06-11 (cascade-dmt build): a root-only <id root="..."/> (the
 * common HL7 II case, where root alone IS the globally unique document id)
 * fell through to the `doc:${importedAt}` timestamp fallback, so every
 * re-import minted a new document URI and duplicated the document in the pod.
 */
import { describe, it, expect } from 'vitest';
import { convertCcda } from '../src/lib/ccda-converter/index.js';

function narrativeCcda(idAttrs: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <id ${idAttrs}/>
  <code code="18748-4" codeSystem="2.16.840.1.113883.6.1" displayName="Diagnostic imaging study"/>
  <title>MRI Brain</title>
  <recordTarget>
    <patientRole>
      <patient>
        <name><given>Jordan</given><family>Rivera</family></name>
        <administrativeGenderCode code="F" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="19920315"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component>
    <structuredBody>
      <component>
        <section>
          <code code="18782-3" codeSystem="2.16.840.1.113883.6.1" displayName="Findings"/>
          <title>Findings</title>
          <text>Two new T2 lesions in the right frontal white matter.</text>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>`;
}

function documentUris(turtle: string): string[] {
  return [...turtle.matchAll(/<(urn:uuid:[0-9a-f-]+)>[^.]*?\ba clinical:ClinicalDocument/gs)].map(
    (m) => m[1],
  );
}

async function convertTwice(xml: string): Promise<[string[], string[]]> {
  const first = await convertCcda(xml, { sourceSystem: 'TestSystem' });
  // Imports at different wall-clock times must agree.
  await new Promise((r) => setTimeout(r, 5));
  const second = await convertCcda(xml, { sourceSystem: 'TestSystem' });
  return [documentUris(first.output), documentUris(second.output)];
}

describe('C-CDA ClinicalDocument URI determinism', () => {
  it('root-only <id> yields the same document URI across runs', async () => {
    const xml = narrativeCcda('root="1.2.840.114350.1.13.999.1.7.8.688883.45777"');
    const [a, b] = await convertTwice(xml);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it('root+extension <id> yields the same document URI across runs', async () => {
    const xml = narrativeCcda('root="1.2.840.114350" extension="DOC-42"');
    const [a, b] = await convertTwice(xml);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it('root-only and root+extension ids produce different URIs', async () => {
    const [a] = await convertTwice(narrativeCcda('root="1.2.840.114350"'));
    const [b] = await convertTwice(narrativeCcda('root="1.2.840.114350" extension="DOC-42"'));
    expect(a[0]).not.toEqual(b[0]);
  });
});
