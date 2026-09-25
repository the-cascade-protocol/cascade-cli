/**
 * A bounded-memory, encrypted scratch store for samples, partitioned by UTC day.
 *
 * WHY IT EXISTS. A real export holds about ten million samples, and a day's
 * aggregate needs every sample of that day, but the file is ordered by sample
 * TYPE, not by date, so a day's samples arrive scattered across the whole pass.
 * Holding them all is 500 MB or more. Instead each sample is appended to its UTC
 * day's partition, buffered up to a fixed budget and then flushed to disk, and
 * the second phase reads one day's partitions at a time.
 *
 * WHY IT IS ENCRYPTED. The partitions are health data in a temporary directory,
 * outside the pod and outside the pod's at-rest protection. Each flushed frame
 * is sealed with AES-256-GCM under a key that exists only in this process's
 * memory and is never written anywhere, so what reaches the disk is unreadable
 * once the process exits, even if cleanup never runs. The key is a per-run
 * secret, not an identity: nothing the store produces is named from it.
 *
 * Frame format, repeated: u32 big-endian ciphertext length, 12-byte nonce,
 * 16-byte tag, ciphertext. The plaintext of a frame is newline-separated lines.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Scratch directories are named `cascade-wellness-<pid>-<random>`, so a sweep can tell whose they are. */
const SPILL_PREFIX = 'cascade-wellness-';

/** Spills this process holds open; closed on SIGINT, SIGTERM and exit. */
const live = new Set<SampleSpill>();
let handlersInstalled = false;

function closeAll(): void {
  for (const s of [...live]) s.close();
}

/**
 * Close every open spill when the process is interrupted or exits, so Ctrl-C
 * during a long import does not leave health data (sealed, but still health
 * data) in the temp directory. After cleanup the signal is re-raised with our
 * handler removed, so the process ends exactly as it would have.
 */
function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', closeAll);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const onSignal = (): void => {
      closeAll();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM: it exists, it just is not ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove scratch directories left by an import that was killed outright
 * (SIGKILL, a crash, a power cut), when no handler could run: those whose
 * owning process is gone, and unowned ones from before names carried a pid
 * once they are a day old. Their key died with the process, so what they hold
 * can never be read again; deleting them loses nothing.
 */
export function sweepStaleSpills(tmp = os.tmpdir()): number {
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(tmp);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(SPILL_PREFIX)) continue;
    const full = path.join(tmp, name);
    const m = /^cascade-wellness-(\d+)-/.exec(name);
    let stale: boolean;
    if (m) {
      const pid = Number(m[1]);
      stale = pid !== process.pid && !processIsAlive(pid);
    } else {
      try {
        stale = Date.now() - fs.statSync(full).mtimeMs > 86_400_000;
      } catch {
        stale = false;
      }
    }
    if (!stale) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {
      // Not ours to remove after all (another user's temp); leave it.
    }
  }
  return removed;
}

export class SampleSpill {
  private readonly dir: string;
  private readonly key: Buffer;
  private readonly buffers = new Map<number, string[]>();
  private bufferedChars = 0;
  private readonly budgetChars: number;
  private readonly written = new Set<number>();
  private closed = false;

  constructor(budgetChars = 8 * 1024 * 1024) {
    sweepStaleSpills();
    installHandlers();
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), `${SPILL_PREFIX}${process.pid}-`));
    this.key = randomBytes(32);
    this.budgetChars = budgetChars;
    live.add(this);
  }

  /** Append one line to the partition for UTC day `day`. */
  add(day: number, line: string): void {
    let b = this.buffers.get(day);
    if (!b) this.buffers.set(day, (b = []));
    b.push(line);
    this.bufferedChars += line.length + 1;
    if (this.bufferedChars >= this.budgetChars) this.flush();
  }

  /** Write every buffered partition to disk and empty the buffers. */
  flush(): void {
    for (const [day, lines] of this.buffers) {
      if (lines.length === 0) continue;
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
      const ct = Buffer.concat([cipher.update(lines.join('\n'), 'utf8'), cipher.final()]);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(ct.length, 0);
      fs.appendFileSync(this.file(day), Buffer.concat([header, nonce, cipher.getAuthTag(), ct]));
      this.written.add(day);
    }
    this.buffers.clear();
    this.bufferedChars = 0;
  }

  /** Every UTC day that holds at least one line, ascending. */
  days(): number[] {
    const all = new Set<number>([...this.written, ...this.buffers.keys()]);
    return [...all].sort((a, b) => a - b);
  }

  /** Every line of the partition for UTC day `day`. Call {@link flush} first. */
  read(day: number): string[] {
    const out: string[] = [];
    const p = this.file(day);
    if (!fs.existsSync(p)) return out;
    const blob = fs.readFileSync(p);
    let off = 0;
    while (off < blob.length) {
      const len = blob.readUInt32BE(off);
      const nonce = blob.subarray(off + 4, off + 16);
      const tag = blob.subarray(off + 16, off + 32);
      const ct = blob.subarray(off + 32, off + 32 + len);
      off += 32 + len;
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAuthTag(tag);
      const text = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
      for (const line of text.split('\n')) if (line) out.push(line);
    }
    return out;
  }

  /** The scratch directory (tests use it to check cleanup). */
  get directory(): string {
    return this.dir;
  }

  /** Delete the scratch directory and forget the key. Safe to call twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    live.delete(this);
    this.buffers.clear();
    this.key.fill(0);
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private file(day: number): string {
    return path.join(this.dir, `${day}.bin`);
  }
}
