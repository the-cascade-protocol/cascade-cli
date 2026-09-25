/**
 * What the wellness import reports, and what it leaves behind:
 *   - a record the export lists twice with identical content is written once
 *     and counted as a duplicate, not as a second record;
 *   - the same name with different content is a collision, never a union;
 *   - every export type the import does not read is counted, per type;
 *   - an interrupted import leaves no scratch directory, and one killed
 *     outright has its scratch directory swept by the next import.
 *
 * Every export here is synthetic.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importAppleHealthWellness } from '../src/lib/apple-health-wellness/import-export.js';
import { stringChunks } from '../src/lib/apple-health-wellness/xml-scanner.js';
import { sweepStaleSpills } from '../src/lib/apple-health-wellness/spill.js';

const SPILL_MODULE = pathToFileURL(path.resolve(__dirname, '../dist/lib/apple-health-wellness/spill.js')).href;

function workout(uuid: string, minutes: string): string {
  return (
    `<Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="${minutes}" durationUnit="min" ` +
    `sourceName="Alex Watch" sourceVersion="10.3" creationDate="2026-03-08 11:34:00 -0700" ` +
    `startDate="2026-03-08 11:00:00 -0700" endDate="2026-03-08 11:33:00 -0700">\n` +
    `  <MetadataEntry key="HKExternalUUID" value="${uuid}"/>\n</Workout>`
  );
}

function exportXml(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n` +
    `<ExportDate value="2026-03-12 09:00:00 -0700"/>\n${body}\n</HealthData>\n`
  );
}

async function importXml(xml: string) {
  const podDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wellness-report-'));
  const report = await importAppleHealthWellness({
    podDir,
    exportXmlPath: 'export.xml',
    chunks: stringChunks(xml, 211),
    machineZoneOverride: 'UTC',
  });
  return { podDir, report };
}

describe('duplicates and collisions within one export', () => {
  it('a workout listed twice with identical content is one workout and one duplicate', async () => {
    const { podDir, report } = await importXml(exportXml([workout('W-1', '33'), workout('W-1', '33'), workout('W-2', '20')].join('\n')));
    expect(report.workouts).toBe(2);
    expect(report.duplicateRecords).toEqual({ workout: 1 });
    expect(report.collisions).toEqual([]);
    const ttl = fs.readFileSync(path.join(podDir, 'wellness', 'activity.ttl'), 'utf8');
    expect(ttl.match(/health:Workout/g)?.length).toBe(2);
  });

  it('one name with different content is a collision: one version is written, never the union', async () => {
    const a = await importXml(exportXml([workout('W-1', '33'), workout('W-1', '41')].join('\n')));
    const b = await importXml(exportXml([workout('W-1', '41'), workout('W-1', '33')].join('\n')));
    expect(a.report.collisions.length).toBe(1);
    expect(a.report.duplicateRecords).toEqual({});
    const ttlA = fs.readFileSync(path.join(a.podDir, 'wellness', 'activity.ttl'), 'utf8');
    // One duration, not two.
    expect(ttlA.match(/health:durationMinutes/g)?.length).toBe(1);
    // And the kept version does not depend on the order the export listed them in.
    expect(fs.readFileSync(path.join(b.podDir, 'wellness', 'activity.ttl'), 'utf8')).toBe(ttlA);
  });
});

describe('export types the import does not read', () => {
  it('are counted per type', async () => {
    const rec = (type: string, value: string): string =>
      `<Record type="${type}" sourceName="Alex Watch" sourceVersion="10.3" unit="count" ` +
      `creationDate="2026-03-08 10:00:00 -0700" startDate="2026-03-08 10:00:00 -0700" endDate="2026-03-08 10:00:00 -0700" value="${value}"/>`;
    const { report } = await importXml(
      exportXml(
        [
          rec('HKQuantityTypeIdentifierFlightsClimbed', '3'),
          rec('HKQuantityTypeIdentifierFlightsClimbed', '2'),
          rec('HKCategoryTypeIdentifierMindfulSession', '0'),
          rec('HKQuantityTypeIdentifierStepCount', '100'),
        ].join('\n'),
      ),
    );
    expect(report.unreadRecordTypes).toEqual({
      HKCategoryTypeIdentifierMindfulSession: 1,
      HKQuantityTypeIdentifierFlightsClimbed: 2,
    });
  });
});

describe('the encrypted scratch directory', () => {
  it('is removed when the import is interrupted with SIGINT', async () => {
    const script =
      `import { SampleSpill } from ${JSON.stringify(SPILL_MODULE)};\n` +
      `const s = new SampleSpill(16);\n` +
      `for (let i = 0; i < 100; i++) s.add(i % 3, 'line ' + i);\n` +
      `s.flush();\n` +
      `process.stdout.write(s.directory + '\\n');\n` +
      `setInterval(() => {}, 1000);\n`;
    const child = spawn('node', ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    const dir = await new Promise<string>((resolve) => {
      let buf = '';
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        if (buf.includes('\n')) resolve(buf.trim());
      });
    });
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir).length).toBeGreaterThan(0);
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on('exit', (_code, signal) => resolve(signal)));
    child.kill('SIGINT');
    // The process still ends by the signal, as it would have without the handler.
    expect(await exited).toBe('SIGINT');
    expect(fs.existsSync(dir)).toBe(false);
  }, 30_000);

  it('left by a process that is gone is swept; one whose process is alive is not', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spill-sweep-'));
    // A pid far above any the system hands out, so it is certainly not running.
    const dead = path.join(tmp, 'cascade-wellness-99999999-abc123');
    const alive = path.join(tmp, `cascade-wellness-${process.pid}-def456`);
    const unrelated = path.join(tmp, 'something-else');
    for (const d of [dead, alive, unrelated]) {
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, '1.bin'), 'sealed');
    }
    expect(sweepStaleSpills(tmp)).toBe(1);
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(alive)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
