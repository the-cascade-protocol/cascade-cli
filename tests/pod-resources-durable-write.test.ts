/**
 * `atomicWriteBytes` must survive a power cut, not just a crash.
 *
 * A rename is atomic against other processes, but without an fsync of the file
 * first the rename can reach the disk before the data does, and a power cut
 * then leaves the target pointing at an empty or partial file. Without an fsync
 * of the directory after, the rename itself can be lost. Neither is visible to
 * an ordinary test (the page cache always has the right answer), so this one
 * records the fs calls and pins their ORDER:
 *
 *   open temp, write temp, fsync temp, close temp, rename temp over target,
 *   open dir, fsync dir, close dir
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

interface FsEvent {
  op: string;
  fd?: number;
  path?: string;
  to?: string;
}

const rec = vi.hoisted(() => ({
  on: false,
  events: [] as Array<{ op: string; fd?: number; path?: string; to?: string }>,
  failRename: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const log = (e: FsEvent): void => {
    if (rec.on) rec.events.push(e);
  };
  const wrapped = {
    openSync: ((p: import('node:fs').PathLike, ...rest: unknown[]) => {
      const fd = (actual.openSync as (...a: unknown[]) => number)(p, ...rest);
      log({ op: 'open', fd, path: String(p) });
      return fd;
    }) as typeof actual.openSync,
    writeFileSync: ((target: unknown, ...rest: unknown[]) => {
      log(typeof target === 'number' ? { op: 'write', fd: target } : { op: 'writeFile', path: String(target) });
      return (actual.writeFileSync as (...a: unknown[]) => void)(target, ...rest);
    }) as typeof actual.writeFileSync,
    writeSync: ((fd: number, ...rest: unknown[]) => {
      log({ op: 'write', fd });
      return (actual.writeSync as (...a: unknown[]) => number)(fd, ...rest);
    }) as typeof actual.writeSync,
    fsyncSync: ((fd: number) => {
      log({ op: 'fsync', fd });
      return actual.fsyncSync(fd);
    }) as typeof actual.fsyncSync,
    closeSync: ((fd: number) => {
      log({ op: 'close', fd });
      return actual.closeSync(fd);
    }) as typeof actual.closeSync,
    renameSync: ((from: import('node:fs').PathLike, to: import('node:fs').PathLike) => {
      log({ op: 'rename', path: String(from), to: String(to) });
      if (rec.failRename) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
  };
  return { ...actual, ...wrapped, default: { ...actual, ...wrapped } };
});

import * as fs from 'node:fs';
import { atomicWriteBytes } from '../src/lib/pod-resources.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-durable-write-'));
  rec.events.length = 0;
  rec.failRename = false;
});

afterEach(() => {
  rec.on = false;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Replace fds and temp names with roles, so the sequence reads as a contract. */
function symbolic(events: FsEvent[], target: string): string[] {
  const fdRole = new Map<number, string>();
  const role = (p: string): string =>
    p === target ? 'target' : p === path.dirname(target) ? 'dir' : /\.tmp$/.test(p) ? 'temp' : `other:${p}`;
  return events.map((e) => {
    if (e.op === 'open') {
      fdRole.set(e.fd!, role(e.path!));
      return `open ${role(e.path!)}`;
    }
    if (e.op === 'rename') return `rename ${role(e.path!)} -> ${role(e.to!)}`;
    if (e.fd !== undefined) return `${e.op} ${fdRole.get(e.fd) ?? 'unknown-fd'}`;
    return `${e.op} ${role(e.path!)}`;
  });
}

describe('atomicWriteBytes: durable ordering', () => {
  it('writes, fsyncs the file, renames, then fsyncs the directory, in that order', () => {
    const target = path.join(dir, 'resource.ttl');
    fs.writeFileSync(target, 'old bytes');

    rec.on = true;
    atomicWriteBytes(target, Buffer.from('new bytes'));
    rec.on = false;

    expect(symbolic(rec.events, target)).toEqual([
      'open temp',
      'write temp',
      'fsync temp',
      'close temp',
      'rename temp -> target',
      'open dir',
      'fsync dir',
      'close dir',
    ]);
    expect(fs.readFileSync(target, 'utf-8')).toBe('new bytes');
    expect(fs.readdirSync(dir)).toEqual(['resource.ttl']);
  });

  it('a failed rename removes the temp file, leaves the target untouched, and fsyncs no directory', () => {
    const target = path.join(dir, 'resource.ttl');
    fs.writeFileSync(target, 'old bytes');

    rec.failRename = true;
    rec.on = true;
    expect(() => atomicWriteBytes(target, Buffer.from('new bytes'))).toThrow(/injected rename failure/);
    rec.on = false;

    const seq = symbolic(rec.events, target);
    expect(seq.slice(0, 5)).toEqual(['open temp', 'write temp', 'fsync temp', 'close temp', 'rename temp -> target']);
    expect(seq).not.toContain('fsync dir');
    expect(fs.readFileSync(target, 'utf-8')).toBe('old bytes');
    expect(fs.readdirSync(dir)).toEqual(['resource.ttl']);
  });
});
