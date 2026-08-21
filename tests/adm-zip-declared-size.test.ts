/**
 * Regression pin for CVE-2026-39244 (GHSA-xpcp-8h2w-3j85, adm-zip < 0.6.0).
 *
 * A ZIP central directory declares the uncompressed size of each entry.
 * adm-zip below 0.6.0 allocated that declared size before validating anything
 * about it, so a ~120-byte archive claiming ~4GB got ~4GB. `cascade convert`
 * accepts a `.zip` from the filesystem and hands it to `convertCcda`, which is
 * how untrusted input reaches that allocation.
 *
 * WHAT THIS FILE ASSERTS, AND WHY IT IS NOT THE OBVIOUS ASSERTION
 *
 * The obvious test -- "a crafted archive is rejected" -- passes on the
 * VULNERABLE version and is therefore worthless as a tripwire. Measured on
 * adm-zip 0.5.16, the crafted archive below throws `ADM-ZIP: CRC32 checksum
 * failed` exactly as it does on 0.6.0. The difference is not the outcome, it is
 * that 0.5.16 allocated 64 MB from a 121-byte file on the way to that outcome.
 * The CVE text says so directly: the allocation occurs BEFORE CRC validation,
 * so the payload cannot be rejected early.
 *
 * So these tests assert on ALLOCATION: they spy on `Buffer.alloc` and record the
 * largest single request made while the archive is read. Observed while writing
 * them, with the entry named `CCD.xml` so the convert path actually reaches it:
 *   adm-zip 0.5.16 -> peak request 67,108,864 bytes from a 121-byte file (RED)
 *   adm-zip 0.6.0  -> peak request well under the threshold          (GREEN)
 *
 * DECLARED_SIZE is 64 MB rather than the ~4GB the advisory describes so that a
 * RED run degrades a CI box instead of killing it. 64 MB against a 121-byte
 * archive is already a ratio over 500,000:1, which is far outside anything a
 * real archive produces and well clear of measurement noise.
 */

import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { convertCcda } from '../src/lib/ccda-converter/index.js';

const DECLARED_SIZE = 64 * 1024 * 1024;

/** Offset of the uncompressed-size field within a central directory header. */
const CD_SIGNATURE = 0x02014b50;
const CD_UNCOMPRESSED_SIZE_OFFSET = 24;

/**
 * A structurally valid STORED archive whose central directory lies about how
 * large the entry expands to. Built with adm-zip itself so that everything
 * except the one patched field is genuinely well-formed.
 */
function craftOversizedDeclaration(): { archive: Buffer; realSize: number } {
  const zip = new AdmZip();
  zip.addFile('CCD.xml', Buffer.from('hello'), '', 0);
  const archive = zip.toBuffer();

  let cd = -1;
  for (let i = 0; i + 4 <= archive.length; i++) {
    if (archive.readUInt32LE(i) === CD_SIGNATURE) {
      cd = i;
      break;
    }
  }
  if (cd < 0) throw new Error('no central directory in the generated archive');

  const realSize = archive.readUInt32LE(cd + CD_UNCOMPRESSED_SIZE_OFFSET);
  archive.writeUInt32LE(DECLARED_SIZE, cd + CD_UNCOMPRESSED_SIZE_OFFSET);
  return { archive, realSize };
}

/**
 * Largest single `Buffer.alloc` request made during `fn`, in bytes.
 *
 * This spies on the allocation rather than sampling `process.memoryUsage()`
 * before and after. Sampling was tried first and is NOT reliable here: when the
 * allocation is followed by a throw, the orphaned buffer can be collected
 * before the "after" sample is taken, so the convert-path case measured ~0 on
 * adm-zip 0.5.16 even though the 64 MB allocation demonstrably happened. The
 * spy answers the question the CVE actually poses -- did anything ask for the
 * declared size -- and is independent of when the collector runs.
 */
async function largestAllocationDuring(fn: () => unknown | Promise<unknown>): Promise<number> {
  const realAlloc = Buffer.alloc;
  let peak = 0;
  (Buffer as { alloc: typeof Buffer.alloc }).alloc = ((size: number, ...rest: unknown[]) => {
    if (typeof size === 'number' && size > peak) peak = size;
    return (realAlloc as (...a: unknown[]) => Buffer)(size, ...rest);
  }) as typeof Buffer.alloc;
  try {
    await fn();
  } catch {
    // Throwing is fine and expected. This measures the cost of getting there.
  } finally {
    (Buffer as { alloc: typeof Buffer.alloc }).alloc = realAlloc;
  }
  return peak;
}

describe('adm-zip declared uncompressed size (CVE-2026-39244)', () => {
  it('crafts an archive whose declaration is wildly larger than its contents', () => {
    const { archive, realSize } = craftOversizedDeclaration();
    expect(realSize).toBe(5);
    // The entry MUST end in .xml: convertCcda only calls getData() on .xml
    // entries, so a differently-named entry makes the convert-path test below
    // vacuous. Observed: with a .txt entry that test passes on adm-zip 0.5.16.
    expect(new AdmZip(archive).getEntries()[0].entryName).toMatch(/\.xml$/);
    expect(archive.length).toBeLessThan(1024);
    // The amplification the advisory is about.
    expect(DECLARED_SIZE / archive.length).toBeGreaterThan(100_000);
  });

  it('does not allocate the declared size when reading an entry directly', async () => {
    const { archive } = craftOversizedDeclaration();
    const peak = await largestAllocationDuring(() =>
      new AdmZip(archive).getEntries()[0].getData(),
    );
    // 0.5.16 allocated the full 64 MB here. Anything approaching the declared
    // size means the pre-allocation is back.
    expect(peak).toBeLessThan(DECLARED_SIZE / 8);
  });

  it('does not allocate the declared size through the C/CDA convert path', async () => {
    const { archive } = craftOversizedDeclaration();
    // This is the reachable path: `cascade convert foo.zip` -> readFileSync ->
    // convertCcda(Buffer). The converter catches zip errors and falls back to
    // treating the bytes as raw XML, which means it swallows the symptom; the
    // allocation is what has to not happen.
    const peak = await largestAllocationDuring(() => convertCcda(archive));
    expect(peak).toBeLessThan(DECLARED_SIZE / 8);
  });

  it('still reads a legitimate archive correctly', async () => {
    const zip = new AdmZip();
    zip.addFile('note.txt', Buffer.from('hello'), '', 0);
    const entry = new AdmZip(zip.toBuffer()).getEntries()[0];
    expect(entry.getData().toString('utf-8')).toBe('hello');
  });
});
