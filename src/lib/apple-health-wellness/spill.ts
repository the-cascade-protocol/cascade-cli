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

export class SampleSpill {
  private readonly dir: string;
  private readonly key: Buffer;
  private readonly buffers = new Map<number, string[]>();
  private bufferedChars = 0;
  private readonly budgetChars: number;
  private readonly written = new Set<number>();
  private closed = false;

  constructor(budgetChars = 8 * 1024 * 1024) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-wellness-'));
    this.key = randomBytes(32);
    this.budgetChars = budgetChars;
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

  /** Delete the scratch directory and forget the key. Safe to call twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffers.clear();
    this.key.fill(0);
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private file(day: number): string {
    return path.join(this.dir, `${day}.bin`);
  }
}
