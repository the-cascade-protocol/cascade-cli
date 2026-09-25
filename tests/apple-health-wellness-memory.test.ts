/**
 * Streaming, bounded memory: the wellness import of a large generated export.
 *
 * A real export is 4.6 GB. The aggregator must read it as a stream and hold
 * neither the file nor its samples in memory. This test generates a synthetic
 * export (invented values), imports it in a CHILD process so the measurement is
 * that process's own peak resident set, and asserts the peak stays far below
 * the file's size and under a fixed ceiling.
 *
 * Size: WELLNESS_MEMORY_RECORDS samples (default 300,000, about 115 MB). Set it
 * higher to measure a larger file; the assertions do not change with it.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.resolve(__dirname, '../dist/index.js');
const MODULE = path.resolve(__dirname, '../dist/lib/apple-health-wellness/import-export.js');
const RECORDS = Number(process.env.WELLNESS_MEMORY_RECORDS ?? 300_000);
const PEAK_RSS_CEILING_MB = 512;
const HEAP_CAP_MB = 192;

const WATCH = '&lt;&lt;HKDevice: 0x6000031a4f00&gt;, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,1, software:10.3&gt;';
const PHONE = '&lt;&lt;HKDevice: 0x600002c8d680&gt;, name:iPhone, manufacturer:Apple Inc., model:iPhone, hardware:iPhone15,2, software:17.4&gt;';

function stamp(ms: number): string {
  const d = new Date(ms - 7 * 3_600_000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 19)} -0700`;
}

/** Write a synthetic export of `n` samples spread over two years, ordered by type as Apple orders it. */
function generate(file: string, n: number): void {
  const fd = fs.openSync(file, 'w');
  const w = (s: string): void => {
    fs.writeSync(fd, s);
  };
  const t0 = Date.parse('2024-01-01T08:00:00Z');
  const span = 730 * 86_400_000;
  w('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE HealthData [\n<!ELEMENT HealthData ANY>\n]>\n<HealthData locale="en_US">\n');
  w(` <ExportDate value="${stamp(t0 + span + 86_400_000)}"/>\n`);
  const types: Array<[string, string, string, (i: number) => string, number]> = [
    ['HeartRate', 'count/min', WATCH, (i) => String(55 + (i % 60)), 0.7],
    ['StepCount', 'count', PHONE, (i) => String(10 + (i % 400)), 0.15],
    ['ActiveEnergyBurned', 'kcal', WATCH, (i) => (0.1 + (i % 50) / 10).toFixed(2), 0.1],
    ['OxygenSaturation', '%', WATCH, (i) => (0.94 + (i % 5) / 100).toFixed(2), 0.05],
  ];
  let buf = '';
  for (const [type, unit, device, value, share] of types) {
    const count = Math.round(n * share);
    for (let i = 0; i < count; i++) {
      const t = t0 + Math.floor((i / count) * span);
      buf +=
        ` <Record type="HKQuantityTypeIdentifier${type}" sourceName="Synthetic ${device === WATCH ? 'Watch' : 'Phone'}" sourceVersion="10.3" ` +
        `device="${device}" unit="${unit}" creationDate="${stamp(t + 60_000)}" startDate="${stamp(t)}" endDate="${stamp(t + 30_000)}" value="${value(i)}"/>\n`;
      if (buf.length > 1 << 20) {
        w(buf);
        buf = '';
      }
    }
  }
  w(buf);
  w('</HealthData>\n');
  fs.closeSync(fd);
}

describe('wellness import streams a large export in bounded memory', () => {
  it(`imports ${RECORDS} samples with a peak RSS under ${PEAK_RSS_CEILING_MB} MB`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wellness-memory-'));
    try {
      const xml = path.join(dir, 'export.xml');
      generate(xml, RECORDS);
      const sizeMB = fs.statSync(xml).size / 1e6;
      const podDir = path.join(dir, 'pod');
      execFileSync('node', [CLI, 'pod', 'init', podDir], { encoding: 'utf-8' });
      const runner = path.join(dir, 'run.mjs');
      fs.writeFileSync(
        runner,
        `import { importAppleHealthWellness } from ${JSON.stringify(MODULE)};\n` +
          `const t = Date.now();\n` +
          `const r = await importAppleHealthWellness({ podDir: process.argv[2], exportXmlPath: process.argv[3] });\n` +
          `console.log(JSON.stringify({ ms: Date.now() - t, maxRssMB: process.resourceUsage().maxRSS / 1024, ` +
          `closedDays: r.closedDays, samples: r.samplesAggregated, records: r.files.reduce((a, f) => a + f.recordsWritten, 0) }));\n`,
      );
      // The child's heap is CAPPED. An importer that kept samples in memory in
      // proportion to the file would run out of heap here and fail, rather than
      // pass on a machine with memory to spare: V8 otherwise lets an idle heap
      // grow with allocation rate, so RSS alone would not tell retention apart
      // from lazy collection.
      const out = JSON.parse(
        execFileSync('node', [`--max-old-space-size=${HEAP_CAP_MB}`, runner, podDir, xml], { encoding: 'utf-8', timeout: 1_200_000 }).trim(),
      ) as {
        ms: number;
        maxRssMB: number;
        closedDays: number;
        samples: number;
        records: number;
      };
      // Printed so a run can be quoted: time, peak memory, and what was read.
      console.log(
        `wellness memory: ${RECORDS} samples, ${sizeMB.toFixed(0)} MB file, ${(out.ms / 1000).toFixed(1)} s, ` +
          `peak RSS ${out.maxRssMB.toFixed(0)} MB, ${out.closedDays} closed days, ${out.records} records`,
      );
      expect(out.samples).toBe(RECORDS);
      expect(out.closedDays).toBe(730);
      expect(out.maxRssMB).toBeLessThan(PEAK_RSS_CEILING_MB);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 1_200_000);
});
