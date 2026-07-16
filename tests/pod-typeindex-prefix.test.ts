/**
 * Regression tests for the type-index prefix self-heal (root backlog 1.6, slice R0).
 *
 * When `cascade pod import` appends a `solid:TypeRegistration` block to a type
 * index, the block's `solid:forClass` CURIE may use any Cascade prefix
 * (clinical:, health:, coverage:, cascade:, fhir:). If the index header does not
 * declare that prefix, the resulting file is unparseable Turtle
 * (`Undefined prefix "coverage:"`), which the 2026-07-16 graph-edge audit found
 * on every fresh pod that imports claims data.
 *
 * These tests lock in that (a) a fresh `pod init` public index already declares
 * `coverage:`, and (b) appending a coverage registration to a *legacy* index that
 * lacks it self-heals so the file still parses under n3's strict parser.
 */

import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  missingPrefixHeader,
  appendTypeRegistration,
} from '../src/commands/pod/import.js';
import { DATA_TYPES } from '../src/commands/pod/helpers.js';
import { PUBLIC_TYPE_INDEX_TTL } from '../src/commands/pod/init.js';

/** Parse Turtle with n3's strict parser; return the parse error (or null). */
function parseError(turtle: string): Error | null {
  const parser = new Parser({ format: 'Turtle' });
  try {
    parser.parse(turtle); // synchronous parse throws on undefined prefix
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

// A pod's public type index as `pod init` produced it BEFORE coverage: was added
// to the header — the exact shape the audit found unparseable after a claims import.
const LEGACY_PUBLIC_INDEX = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .

<> a solid:TypeIndex, solid:ListedDocument .
`;

describe('missingPrefixHeader (R0 self-heal)', () => {
  it('declares coverage: when a block uses it and the file lacks it', () => {
    const block = '\n<#claims> a solid:TypeRegistration ;\n    solid:forClass coverage:ClaimRecord ;\n    solid:instance </clinical/claims.ttl> .\n';
    const header = missingPrefixHeader(block, LEGACY_PUBLIC_INDEX);
    expect(header).toContain('@prefix coverage: <https://ns.cascadeprotocol.org/coverage/v1#> .');
  });

  it('returns empty when every used prefix is already declared', () => {
    const block = '\n<#conditions> a solid:TypeRegistration ;\n    solid:forClass health:ConditionRecord ;\n    solid:instance </clinical/conditions.ttl> .\n';
    expect(missingPrefixHeader(block, LEGACY_PUBLIC_INDEX)).toBe('');
  });

  it('declares fhir: for a passthrough registration on a header that lacks it', () => {
    const block = '\n<#fhir-passthrough> a solid:TypeRegistration ;\n    solid:forClass fhir: ;\n    solid:instance </clinical/fhir-passthrough.ttl> .\n';
    const header = missingPrefixHeader(block, LEGACY_PUBLIC_INDEX);
    expect(header).toContain('@prefix fhir: <http://hl7.org/fhir/> .');
  });

  it('declares multiple missing prefixes at once', () => {
    const minimal = '@prefix solid: <http://www.w3.org/ns/solid/terms#> .\n<> a solid:TypeIndex .\n';
    const block = '\n<#benefits> a solid:TypeRegistration ;\n    solid:forClass coverage:BenefitStatement ;\n    solid:instance </clinical/benefits.ttl> .\n';
    const header = missingPrefixHeader(block, minimal);
    expect(header).toContain('@prefix coverage:');
  });
});

describe('appendTypeRegistration round-trip parses under n3 (R0)', () => {
  it('self-heals a legacy index so a coverage registration still parses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cascade-r0-'));
    const indexPath = join(dir, 'publicTypeIndex.ttl');
    writeFileSync(indexPath, LEGACY_PUBLIC_INDEX, 'utf-8');

    // Before the fix this produced `coverage:ClaimRecord` with no @prefix coverage:.
    return appendTypeRegistration(indexPath, 'claims', DATA_TYPES.claims, false).then((appended) => {
      expect(appended).toBe(true);
      const result = readFileSync(indexPath, 'utf-8');
      expect(result).toContain('coverage:ClaimRecord');
      const err = parseError(result);
      expect(err, err?.message).toBeNull();
    });
  });

  it('keeps a fresh `pod init` index parseable after a coverage registration', () => {
    // The fresh template already declares coverage:; appending must not break it.
    const dir = mkdtempSync(join(tmpdir(), 'cascade-r0-'));
    const indexPath = join(dir, 'publicTypeIndex.ttl');
    writeFileSync(indexPath, PUBLIC_TYPE_INDEX_TTL, 'utf-8');

    return appendTypeRegistration(indexPath, 'benefits', DATA_TYPES.benefits, false).then(() => {
      const result = readFileSync(indexPath, 'utf-8');
      expect(result).toContain('coverage:BenefitStatement');
      const err = parseError(result);
      expect(err, err?.message).toBeNull();
    });
  });

  it('the fresh public type index template declares coverage:', () => {
    expect(PUBLIC_TYPE_INDEX_TTL).toContain('@prefix coverage: <https://ns.cascadeprotocol.org/coverage/v1#> .');
    expect(parseError(PUBLIC_TYPE_INDEX_TTL)).toBeNull();
  });
});
