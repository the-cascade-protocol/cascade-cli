/**
 * Output formatting utilities for consistent CLI output.
 *
 * Supports both human-readable text and machine-readable JSON output modes.
 */

import { writeSync } from 'node:fs';

export interface OutputOptions {
  json: boolean;
  verbose: boolean;
}

/**
 * Format data for output in either JSON or human-readable text mode.
 */
export function formatOutput(data: unknown, opts: OutputOptions): string {
  if (opts.json) {
    return JSON.stringify(data, null, 2);
  }

  if (typeof data === 'string') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => formatSingleItem(item)).join('\n');
  }

  return formatSingleItem(data);
}

/**
 * Format a single item for human-readable output.
 */
function formatSingleItem(item: unknown): string {
  if (typeof item === 'string') {
    return item;
  }

  if (typeof item === 'object' && item !== null) {
    const entries = Object.entries(item as Record<string, unknown>);
    return entries.map(([key, value]) => `  ${key}: ${String(value)}`).join('\n');
  }

  return String(item);
}

/**
 * Print result data to stdout.
 *
 * Uses synchronous fs.writeSync() instead of console.log() to bypass Bun's
 * internal userspace stdout buffer. For large outputs (multi-MB Turtle docs
 * embedded in JSON), console.log() in a Bun-compiled binary may not flush
 * the full buffer before the process exits, causing truncated JSON that fails
 * to parse in the Tauri sidecar host. writeSync() issues a direct OS write(2)
 * syscall and loops until all bytes are written to fd 1.
 */
export function printResult(data: unknown, opts: OutputOptions): void {
  const str = formatOutput(data, opts) + '\n';
  const buf = Buffer.from(str, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    offset += writeSync(1, buf, offset, buf.length - offset);
  }
}

/**
 * Print an error message to stderr.
 */
export function printError(message: string, opts: OutputOptions): void {
  if (opts.json) {
    console.error(JSON.stringify({ error: message }));
  } else {
    console.error(`ERROR: ${message}`);
  }
}

/**
 * Print a verbose/debug message (only if verbose mode is enabled).
 */
export function printVerbose(message: string, opts: OutputOptions): void {
  if (opts.verbose) {
    if (opts.json) {
      console.error(JSON.stringify({ debug: message }));
    } else {
      console.error(`[verbose] ${message}`);
    }
  }
}
