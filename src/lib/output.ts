/**
 * Output formatting utilities for consistent CLI output.
 *
 * Supports both human-readable text and machine-readable JSON output modes.
 */


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
 * Uses process.stdout.write() for correct backpressure handling in Node.js
 * subprocess mode (execSync pipes). For Bun compiled binaries where stdout
 * may not flush before exit, the caller should ensure the process does not
 * exit immediately after large writes.
 */
export function printResult(data: unknown, opts: OutputOptions): void {
  process.stdout.write(formatOutput(data, opts) + '\n');
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
 * Print an error to stderr WITH machine-readable detail alongside it.
 *
 * In `--json` mode the extra fields are merged into the same `{ error }`
 * envelope, so a consumer can branch on a state (`readable: false`) instead of
 * pattern-matching English. In text mode the prose message is all there is —
 * the message must therefore stand on its own, and the detail is strictly
 * additive.
 */
export function printErrorDetail(
  message: string,
  detail: Record<string, unknown>,
  opts: OutputOptions,
): void {
  if (opts.json) {
    console.error(JSON.stringify({ error: message, ...detail }));
  } else {
    console.error(`ERROR: ${message}`);
  }
}

/**
 * Print a warning to stderr, ALWAYS. Not gated on --verbose.
 *
 * For facts a user needs even when the command succeeds: "this ran, and here is
 * something about the result you would not otherwise know". A warning that only
 * appears under --verbose is a warning nobody reads.
 */
export function printWarning(message: string, opts: OutputOptions): void {
  if (opts.json) {
    console.error(JSON.stringify({ warning: message }));
  } else {
    console.error(`WARNING: ${message}`);
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
