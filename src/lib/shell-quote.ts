/**
 * Shell quoting for the command lines this tool SUGGESTS a person run.
 *
 * WHY THIS IS A MODULE AND NOT A FIX AT ONE SITE
 * ----------------------------------------------
 * Several verbs end their output with a command to copy: `pod reconcile` prints
 * the `--apply` re-run, `pod doctor` prints the `--write` re-run, `pod conflicts`
 * prints the `pod resolve` invocation, and half a dozen error paths print a
 * remediation line. Every one of them interpolates a path the user handed in, and
 * every one of them was doing it raw.
 *
 * A raw path is correct only while it contains no shell metacharacter. On the
 * primary desktop platform for this tool the default pod location is under
 * `~/Library/Application Support/`, so the suggested command splits at the space
 * and the copied line fails with "too many arguments" — the paste fails on the
 * one platform where the default path is used. Measured live on a real pod.
 *
 * The class of defect is "a path was interpolated into a command line without
 * being quoted", so the repair is one function that every such site calls,
 * exactly like `json-output.ts` is the one door for JSON text. A per-site repair
 * is how the next verb to print a hint reintroduces it.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * This is not a general shell escaper for building command lines to EXECUTE.
 * Nothing in this codebase shells out through a string; child processes are
 * spawned with argument arrays, which is why the defect could only ever reach
 * printed text. Keeping the function scoped to display keeps it from being
 * mistaken for a sanitizer that makes untrusted input safe to `exec`.
 */

/**
 * Characters that are safe unquoted in every POSIX shell and in every
 * PowerShell-compatible shell this output might be pasted into.
 *
 * Deliberately conservative. `~` is excluded even though it is harmless mid-word,
 * because a leading `~` is expanded and a quoted `~` is not, and a path that
 * genuinely begins with a tilde character must not be turned into a home
 * directory reference by the act of printing it. Everything outside this set is
 * quoted rather than escaped, so the rule stays one rule.
 */
const SAFE_UNQUOTED = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Render one argument so that a POSIX shell word-splits it back to exactly the
 * input string.
 *
 * Single quotes, because inside them the shell interprets nothing at all: no
 * variable expansion, no backslash escapes, no globbing. The one character a
 * single-quoted string cannot contain is a single quote, and the standard
 * construction for that is to close the quote, emit an escaped quote, and reopen
 * (`it's` -> `'it'\''s'`), which is what the replacement below builds.
 *
 * The empty string quotes to `''` rather than to nothing, because an argument
 * that vanishes from a command line changes what the command means.
 */
export function shellQuote(value: string): string {
  if (value.length > 0 && SAFE_UNQUOTED.test(value)) return value;
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * A whole command line: the verb words, then arguments, each quoted as needed.
 *
 * Provided so a caller writes `shellCommand('cascade', 'pod', 'reconcile', dir,
 * '--apply')` and cannot forget the one interpolation that mattered. Literal
 * words pass through untouched when they need no quoting, so the printed line
 * still reads as a command rather than as an escaped blob.
 */
export function shellCommand(...parts: string[]): string {
  return parts.map((p) => shellQuote(p)).join(' ');
}
