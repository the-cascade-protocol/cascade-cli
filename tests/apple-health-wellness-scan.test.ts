/**
 * Apple Health export.xml: the streaming scanner, the Correlation rule, and
 * the device string.
 *
 * All XML here is synthetic and invented; no real export is used.
 */

import { describe, it, expect } from 'vitest';
import { scanXml, stringChunks, decodeXmlText, type XmlEvent } from '../src/lib/apple-health-wellness/xml-scanner.js';
import { scanExport } from '../src/lib/apple-health-wellness/scan.js';
import { SampleSpill } from '../src/lib/apple-health-wellness/spill.js';
import { aggregate } from '../src/lib/apple-health-wellness/aggregate.js';
import {
  stripDeviceAddress,
  parseAppleDevice,
  deviceIdentityOf,
  normalizeName,
} from '../src/lib/apple-health-wellness/device.js';
import { parseAppleTimestamp, isoUtc } from '../src/lib/apple-health-wellness/time.js';

const DOCTYPE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!-- A comment with a quote ' and a bracket ] inside -->
<!ELEMENT HealthData (ExportDate,(Record|Correlation)*)>
<!ATTLIST Record
  type CDATA #REQUIRED
>
<!-- Note: Any Records that appear as children of a correlation also appear as top-level records in this document. -->
]>`;

async function events(xml: string, chunk: number): Promise<string[]> {
  const out: string[] = [];
  await scanXml(stringChunks(xml, chunk), (e: XmlEvent) => {
    out.push(e.kind === 'open' ? `<${e.name} ${JSON.stringify(e.attrs)}${e.selfClosing ? '/' : ''}>` : `</${e.name}>`);
  });
  return out;
}

describe('streaming XML scanner', () => {
  const xml =
    DOCTYPE +
    `<HealthData locale="en_US"><ExportDate value="2026-03-10 09:00:00 -0700"/>` +
    `<Record type="T" note='a > b' device="&lt;&lt;HKDevice: 0x1&gt;, name:Watch&gt;" sourceName="Alex&#8217;s Watch &amp; Co">` +
    `<MetadataEntry key="k" value="v"/></Record><![CDATA[ <Record type="ignored"/> ]]></HealthData>`;

  it('skips the DOCTYPE internal subset, comments and CDATA, and handles a quoted ">"', async () => {
    const ev = await events(xml, 4096);
    expect(ev.filter((e) => !e.startsWith('</')).map((e) => e.split(' ')[0])).toEqual([
      '<HealthData',
      '<ExportDate',
      '<Record',
      '<MetadataEntry',
    ]);
    expect(ev.some((e) => e.includes('ignored'))).toBe(false);
  });

  it('decodes entities and numeric character references in attribute values', async () => {
    const ev = await events(xml, 4096);
    const rec = ev.find((e) => e.startsWith('<Record'))!;
    expect(rec).toContain('Alex’s Watch & Co');
    expect(rec).toContain('<<HKDevice: 0x1>, name:Watch>');
    expect(rec).toContain('a > b');
    expect(decodeXmlText('&#x41;&#66;&lt;')).toBe('AB<');
  });

  it('produces the same events whatever the chunk boundaries', async () => {
    const whole = await events(xml, 1 << 20);
    for (const size of [1, 2, 3, 7, 13, 64]) {
      expect(await events(xml, size)).toEqual(whole);
    }
  });
});

describe('the Correlation rule: a nested record is a copy of a top-level one', () => {
  const watch = `&lt;&lt;HKDevice: 0x6000031a4f00&gt;, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,1, software:10.3&gt;`;
  const step = `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" sourceVersion="10.3" device="${watch}" unit="count" creationDate="2026-03-08 10:11:00 -0700" startDate="2026-03-08 10:00:00 -0700" endDate="2026-03-08 10:10:00 -0700" value="1200"/>`;
  // The export's DTD guarantees every Record inside a Correlation also appears
  // at top level. This synthetic file nests a copy of the one top-level
  // step sample, which is exactly the shape that double counts when both are read.
  const xml =
    DOCTYPE +
    `<HealthData locale="en_US"><ExportDate value="2026-03-12 09:00:00 -0700"/>` +
    step +
    `<Correlation type="HKCorrelationTypeIdentifierFood" sourceName="Watch" startDate="2026-03-08 10:00:00 -0700" endDate="2026-03-08 10:10:00 -0700">${step}</Correlation>` +
    `</HealthData>`;

  it('reads only the top-level record and counts the nested copy as skipped', async () => {
    const spill = new SampleSpill();
    try {
      const scan = await scanExport(stringChunks(xml, 11), spill);
      expect(scan.recordsRead).toBe(1);
      expect(scan.samplesSpilled).toBe(1);
      expect(scan.correlationRecordsSkipped).toBe(1);
      const agg = aggregate(scan, spill, { podSubject: '/profile/card.ttl#me', dayZone: 'America/Los_Angeles' });
      const steps = agg.records.filter((r) => r.kind === 'stepSnapshot');
      expect(steps).toHaveLength(1);
      expect(steps[0].kind === 'stepSnapshot' && steps[0].steps).toBe(1200);
      expect(steps[0].kind === 'stepSnapshot' && steps[0].sampleCount).toBe(1);
    } finally {
      spill.close();
    }
  });
});

describe('the device string', () => {
  const a = '<<HKDevice: 0x78a564f00>, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch3,3, software:6.1.1, creation date:2020-01-02 10:00:00 -0700>';
  const b = '<<HKDevice: 0x6000044b5e10>, name:Apple Watch, manufacturer:Apple, model:Watch, hardware:Watch3,3, software:6.2, creation date:2020-01-02 10:00:00 -0700>';

  it('strips the per-export memory address and nothing else', () => {
    expect(stripDeviceAddress(a)).toBe(
      '<<HKDevice: >, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch3,3, software:6.1.1, creation date:2020-01-02 10:00:00 -0700>',
    );
    expect(stripDeviceAddress(a.replace('0x78a564f00', '0x1f'))).toBe(stripDeviceAddress(a));
  });

  it('parses fields whose values contain commas', () => {
    expect(parseAppleDevice(a)).toEqual({
      name: 'Apple Watch',
      manufacturer: 'Apple Inc.',
      model: 'Watch',
      hardware: 'Watch3,3',
      software: '6.1.1',
    });
  });

  it('identifies a device by name and hardware, never by address, manufacturer or software', () => {
    expect(deviceIdentityOf(a)!.identity).toBe(deviceIdentityOf(b)!.identity);
    const other = a.replace('hardware:Watch3,3', 'hardware:Watch6,1');
    expect(deviceIdentityOf(other)!.identity).not.toBe(deviceIdentityOf(a)!.identity);
    expect(deviceIdentityOf('')).toBeUndefined();
    expect(deviceIdentityOf('not a device')).toBeUndefined();
  });

  it('normalizes curly apostrophes and whitespace in names', () => {
    expect(normalizeName('Alex’s  Apple Watch ')).toBe("Alex's Apple Watch");
  });
});

describe('Apple timestamps', () => {
  it('parse to the UTC instant the offset states', () => {
    expect(isoUtc(parseAppleTimestamp('2026-03-08 23:30:00 -0700')!)).toBe('2026-03-09T06:30:00Z');
    expect(isoUtc(parseAppleTimestamp('2026-03-08 23:30:00 +0100')!)).toBe('2026-03-08T22:30:00Z');
    expect(parseAppleTimestamp('2026-03-08T23:30:00Z')).toBeUndefined();
    expect(parseAppleTimestamp(undefined)).toBeUndefined();
  });
});
