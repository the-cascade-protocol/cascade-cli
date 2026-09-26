/**
 * Every pod read and write goes through the pod path chokepoint
 * (`src/lib/pod-path.ts`), which never follows a symbolic link inside a pod.
 *
 * A single raw `fs.readFileSync(path.join(pod, ...))` in a pod module is enough
 * to read another folder's records as the pod's, or to write outside the pod,
 * and nothing about it looks wrong in review. So the modules that touch pods
 * are scanned, and every raw file-system read, write, folder creation, listing
 * or removal left in them is accounted for below, with the reason it is not a
 * pod path (or is one the chokepoint cannot serve). A new one fails this test
 * until it is either routed through `pod-path.ts` or listed here with its
 * reason. A removed one fails it too, so the list only ever shrinks on purpose.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve(__dirname, '..', 'src');
const CHOKEPOINT = 'lib/pod-path.ts';

/** The modules that read or write inside a pod. */
function podModules(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) out.push(path.relative(SRC, full).split(path.sep).join('/'));
    }
  };
  walk(SRC);
  const inScope = (rel: string): boolean =>
    rel.startsWith('commands/pod/') ||
    rel.startsWith('lib/mcp/') ||
    rel.startsWith('lib/advisory/') ||
    /^lib\/pod-[a-z-]+\.ts$/.test(rel) ||
    [
      'commands/sources.ts',
      'commands/advisory.ts',
      'lib/bucket-write.ts',
      'lib/annotations.ts',
      'lib/user-resolutions.ts',
      'lib/tier0-journal.ts',
      'lib/resolution-retractions.ts',
    ].includes(rel);
  return out.filter((rel) => inScope(rel) && rel !== CHOKEPOINT).sort();
}

/**
 * A raw read, write, folder creation, listing, copy, rename or removal: a
 * file-system method name on ANY receiver (`fs.`, `fsp.`, `fs.promises.`,
 * `require('node:fs').`, an alias), or called bare after a named import. The
 * three short names (`rm`, `open`, `cp`) are matched only on the usual
 * receivers, since other objects have methods called that too.
 */
const RAW_IO =
  /\.(?:readFile|writeFile|appendFile|mkdir|copyFile|readdir|rmdir|unlink|rename|truncate|createReadStream|createWriteStream)(?:Sync)?\(|\b(?:fs|fsp|fsSync|promises)\.(?:rm|open|cp)(?:Sync)?\(|(?<![.\w])(?:readFile|writeFile|appendFile|mkdir|readdir|copyFile|rm|open|cp)(?:Sync)?\(/g;

/** Every raw call left in the pod modules, and why it is not a pod path. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'commands/advisory.ts': { count: 1, why: 'reads a patch or signature file the user named' },
  'commands/pod/export.ts': { count: 1, why: 'writes the export notice into the export folder, outside the pod' },
  'commands/pod/extract.ts': { count: 1, why: 'lists the local models folder' },
  'commands/pod/helpers.ts': { count: 3, why: 'the export copy creates and writes the export folder, outside the pod' },
  'commands/pod/import.ts': { count: 2, why: 'reads an input document the user named; writes the --report file' },
  'commands/pod/init.ts': { count: 1, why: 'creates the pod root itself, which may be reached through a link' },
  'commands/pod/reconcile.ts': { count: 3, why: 'writes the --report file' },
  'lib/pod-encryption.ts': { count: 1, why: 'opens the header O_NOFOLLOW after the chokepoint resolved its path' },
  'lib/pod-read.ts': { count: 1, why: 'the record walker: Dirent kinds, so a link is neither a file nor a folder' },
  'lib/pod-resources.ts': { count: 1, why: 'the encrypt/decrypt walker: Dirent kinds, links skipped' },
  'lib/pod-rekey.ts': {
    count: 12,
    why: 'the re-key walk (lstat, links refused) and the renames and removals of the pod folder and its siblings',
  },
};

describe('pod path chokepoint', () => {
  it('scans a non-empty set of pod modules, and the chokepoint exists', () => {
    const mods = podModules();
    expect(mods.length).toBeGreaterThan(30);
    expect(mods).toContain('lib/bucket-write.ts');
    expect(mods).toContain('commands/pod/query.ts');
    expect(fs.existsSync(path.join(SRC, CHOKEPOINT))).toBe(true);
  });

  it('no pod module does raw file-system I/O beyond the accounted-for calls', () => {
    const found: Record<string, number> = {};
    for (const rel of podModules()) {
      const n = (fs.readFileSync(path.join(SRC, rel), 'utf-8').match(RAW_IO) ?? []).length;
      if (n > 0) found[rel] = n;
    }
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([k, v]) => [k, v.count]));
    expect(found).toEqual(expected);
  });
});
