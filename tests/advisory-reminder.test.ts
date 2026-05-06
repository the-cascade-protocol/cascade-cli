/**
 * Tests for the CAP reminder state manager (TASK-4.7).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getDueChecks,
  markChecked,
  getLastChecked,
  readAllChecked,
  tierFromAdvisoryClass,
  TIER_INTERVAL_MS,
  ALL_TIERS,
} from '../src/lib/advisory/reminder.js';

let podDir: string;
beforeEach(() => {
  podDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-reminder-test-'));
});
afterEach(() => {
  fs.rmSync(podDir, { recursive: true, force: true });
});

describe('getDueChecks — never-checked pod', () => {
  it('returns ALL tiers for a brand-new pod', () => {
    const due = getDueChecks(podDir);
    expect(due.sort()).toEqual([...ALL_TIERS].sort());
  });
});

describe('getDueChecks — SafetyCritical always due', () => {
  it('reports SafetyCritical as due even immediately after a check', () => {
    const now = new Date('2026-05-04T12:00:00Z');
    markChecked(podDir, 'SafetyCritical', now);
    expect(getDueChecks(podDir, now)).toContain('SafetyCritical');
  });
});

describe('getDueChecks — interval gating', () => {
  it('does NOT report VariantReclassification as due 1 day after a check', () => {
    const checkTime = new Date('2026-05-04T12:00:00Z');
    markChecked(podDir, 'VariantReclassification', checkTime);

    const oneDayLater = new Date(checkTime.getTime() + 24 * 60 * 60 * 1000);
    const due = getDueChecks(podDir, oneDayLater);
    expect(due).not.toContain('VariantReclassification');
  });

  it('reports VariantReclassification as due exactly at the interval', () => {
    const checkTime = new Date('2026-05-04T12:00:00Z');
    markChecked(podDir, 'VariantReclassification', checkTime);

    const monthLater = new Date(
      checkTime.getTime() + TIER_INTERVAL_MS.VariantReclassification,
    );
    const due = getDueChecks(podDir, monthLater);
    expect(due).toContain('VariantReclassification');
  });

  it('reports SurveillanceGuidelineUpdate as due after ~91 days', () => {
    const checkTime = new Date('2026-01-01T00:00:00Z');
    markChecked(podDir, 'SurveillanceGuidelineUpdate', checkTime);
    const ninetyTwoDays = new Date(checkTime.getTime() + 92 * 24 * 60 * 60 * 1000);
    expect(getDueChecks(podDir, ninetyTwoDays)).toContain('SurveillanceGuidelineUpdate');
  });

  it('reports GeneralKnowledgeUpdate as NOT due after only 6 months', () => {
    const checkTime = new Date('2026-01-01T00:00:00Z');
    markChecked(podDir, 'GeneralKnowledgeUpdate', checkTime);
    const halfYear = new Date(checkTime.getTime() + 180 * 24 * 60 * 60 * 1000);
    expect(getDueChecks(podDir, halfYear)).not.toContain('GeneralKnowledgeUpdate');
  });
});

describe('markChecked + getLastChecked', () => {
  it('round-trips a tier check', () => {
    const now = new Date('2026-05-04T12:00:00Z');
    markChecked(podDir, 'VariantReclassification', now);
    expect(getLastChecked(podDir, 'VariantReclassification')).toBe(now.toISOString());
  });

  it('returns null for never-checked tiers', () => {
    expect(getLastChecked(podDir, 'DrugInteraction')).toBeNull();
  });

  it('overwrites a previous check', () => {
    const t1 = new Date('2026-01-01T00:00:00Z');
    const t2 = new Date('2026-05-04T00:00:00Z');
    markChecked(podDir, 'DrugInteraction', t1);
    markChecked(podDir, 'DrugInteraction', t2);
    expect(getLastChecked(podDir, 'DrugInteraction')).toBe(t2.toISOString());
  });
});

describe('readAllChecked', () => {
  it('returns the full state map', () => {
    const t = new Date('2026-05-04T00:00:00Z');
    markChecked(podDir, 'VariantReclassification', t);
    markChecked(podDir, 'DrugInteraction', t);
    const all = readAllChecked(podDir);
    expect(all).toEqual({
      VariantReclassification: t.toISOString(),
      DrugInteraction: t.toISOString(),
    });
  });

  it('returns an empty map for a never-checked pod', () => {
    expect(readAllChecked(podDir)).toEqual({});
  });

  it('tolerates a corrupted state file', () => {
    fs.mkdirSync(path.join(podDir, '.advisory-state'), { recursive: true });
    fs.writeFileSync(
      path.join(podDir, '.advisory-state', 'last-checked.json'),
      'NOT JSON',
      'utf8',
    );
    expect(readAllChecked(podDir)).toEqual({});
    expect(getDueChecks(podDir).length).toBe(ALL_TIERS.length);
  });
});

describe('tierFromAdvisoryClass', () => {
  it('canonicalizes a full IRI', () => {
    expect(
      tierFromAdvisoryClass(
        'https://ns.cascadeprotocol.org/advisory/v1#VariantReclassification',
      ),
    ).toBe('VariantReclassification');
  });

  it('accepts a bare local name', () => {
    expect(tierFromAdvisoryClass('DrugInteraction')).toBe('DrugInteraction');
  });

  it('returns null for an unrecognized class', () => {
    expect(tierFromAdvisoryClass('SomethingElse')).toBeNull();
    expect(tierFromAdvisoryClass('')).toBeNull();
  });
});
