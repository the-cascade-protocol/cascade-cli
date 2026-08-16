/**
 * Command SUGGESTIONS have to survive being pasted.
 *
 * A verb that ends with "re-run this to apply it" is making a promise: the line
 * it printed is the line that does the thing. On the primary desktop platform
 * the default pod location contains a space, so the unquoted form of that
 * promise splits into two arguments and the paste fails with "too many
 * arguments" — reliably, on the platform where the default path is used.
 *
 * So the assertion here is not "the string contains a quote character". It is
 * the property that matters: word-split the printed line the way a POSIX shell
 * would, and the argument that comes back is byte-identical to the path that
 * went in. That property is what a user experiences, and it is invariant to how
 * the quoting was done.
 *
 * The last block is the CLASS gate. One fixed call site does not stop the next
 * verb from interpolating a raw path, and this defect arrived that way: several
 * verbs each grew their own hint. The gate reads the command sources and fails
 * on any new template that puts a pod directory straight into a `cascade …`
 * line.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shellQuote, shellCommand } from '../src/lib/shell-quote.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'index.js');

/**
 * A POSIX shell's word splitting, restricted to the constructs a quoted argument
 * can contain: single quotes (literal throughout), double quotes, and backslash
 * escapes. Deliberately written from the shell's rules rather than from the
 * quoter's, so it cannot agree with a broken quoter by sharing its mistake.
 */
function shellSplit(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let started = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') {
      if (started) {
        words.push(current);
        current = '';
        started = false;
      }
      i++;
      continue;
    }
    started = true;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new Error(`unterminated single quote in: ${line}`);
      current += line.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) {
          current += line[i + 1];
          i += 2;
          continue;
        }
        current += line[i];
        i++;
      }
      if (i >= line.length) throw new Error(`unterminated double quote in: ${line}`);
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < line.length) {
      current += line[i + 1];
      i += 2;
      continue;
    }
    current += c;
    i++;
  }
  if (started) words.push(current);
  return words;
}

// ---------------------------------------------------------------------------
// The quoter
// ---------------------------------------------------------------------------

describe('shellQuote: every argument word-splits back to exactly itself', () => {
  const cases: Array<[string, string]> = [
    ['plain', '/Users/example/pods/my-pod'],
    ['the platform default location, which contains a space', '/Users/example/Library/Application Support/org.example.app/pod'],
    ['an apostrophe in a directory name', "/Users/example/Ada's pods/pod"],
    ['a double quote', '/tmp/say "hello"/pod'],
    ['a dollar sign that must not expand', '/tmp/$HOME/pod'],
    ['a backtick that must not run', '/tmp/`whoami`/pod'],
    ['a glob character that must not expand', '/tmp/pods/*/current'],
    ['a semicolon that must not end the command', '/tmp/a;rm -rf b/pod'],
    ['a newline', '/tmp/line\nbreak/pod'],
    ['a backslash', '/tmp/back\\slash/pod'],
    ['a tilde that names a real directory, not a home reference', '~notauser/pod'],
    ['non-ASCII', '/tmp/pöd/Hôpital Saint-Étienne'],
  ];

  it.each(cases)('%s', (_name, value) => {
    expect(shellSplit(shellQuote(value))).toEqual([value]);
  });

  it('quotes the empty string to something that is still an argument', () => {
    // An argument that vanishes changes what the command means, so the empty
    // string must not quote to the empty text.
    expect(shellQuote('')).toBe("''");
    expect(shellSplit(`cascade pod info ${shellQuote('')}`)).toEqual(['cascade', 'pod', 'info', '']);
  });

  it('leaves an ordinary path unquoted, so the hint still reads as a command', () => {
    // Quoting everything would be correct and unreadable. The common case has to
    // look like something a person would type.
    expect(shellQuote('/Users/example/my-pod')).toBe('/Users/example/my-pod');
    expect(shellCommand('cascade', 'pod', 'reconcile', './my-pod', '--apply')).toBe(
      'cascade pod reconcile ./my-pod --apply',
    );
  });

  it('splits a whole suggested command back into its exact arguments', () => {
    const dir = '/Users/example/Library/Application Support/org.example.app/pod';
    const line = shellCommand('cascade', 'pod', 'reconcile', dir, '--apply');
    expect(shellSplit(line)).toEqual(['cascade', 'pod', 'reconcile', dir, '--apply']);
  });
});

// ---------------------------------------------------------------------------
// The verb that prints it
// ---------------------------------------------------------------------------

describe('pod reconcile: the dry-run footer is a line that can be pasted', () => {
  it('round-trips a pod directory containing a space', () => {
    // The real shape: a pod under a directory named the way the platform names
    // its per-application support directory.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-shellquote-'));
    const podDir = path.join(root, 'Application Support', 'org.example.app', 'pod');
    fs.mkdirSync(path.join(podDir, 'clinical'), { recursive: true });
    fs.writeFileSync(path.join(podDir, 'index.ttl'), '', 'utf-8');
    // Two copies of one result from two known origins, so the run has something
    // to report and therefore prints the footer at all.
    fs.writeFileSync(
      path.join(podDir, 'clinical', 'lab-results.ttl'),
      `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
<urn:uuid:shellquote-lab-1> a health:LabResultRecord ;
  cascade:sourceSystem "batch-a" ;
  cascade:sourceIdentity "org:stonebridge" ;
  health:testCode <http://loinc.org/rdf#2951-2> ;
  health:testName "Sodium" ;
  health:performedDate "2031-05-20" ;
  health:resultValue "141" .

<urn:uuid:shellquote-lab-2> a health:LabResultRecord ;
  cascade:sourceSystem "batch-b" ;
  cascade:sourceIdentity "org:larkfield" ;
  health:testCode <http://loinc.org/rdf#2951-2> ;
  health:testName "Sodium" ;
  health:performedDate "2031-05-20" ;
  health:resultValue "141" .
`,
      'utf-8',
    );

    try {
      const r = spawnSync(process.execPath, [CLI, 'pod', 'reconcile', podDir], {
        encoding: 'utf-8',
        timeout: 120000,
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      const line = out
        .split('\n')
        .find((l) => l.includes('Re-run with --apply'));
      expect(line, `no --apply suggestion in:\n${out}`).toBeTruthy();

      const suggestion = (line as string).slice((line as string).indexOf('cascade'));
      const words = shellSplit(suggestion.trim());
      expect(words[0]).toBe('cascade');
      expect(words.slice(1, 3)).toEqual(['pod', 'reconcile']);
      // THE ASSERTION. The path the shell would hand the binary is the path we
      // were given, not its first space-delimited fragment.
      expect(words[3]).toBe(podDir);
      expect(words[4]).toBe('--apply');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The class
// ---------------------------------------------------------------------------

/**
 * Files whose command hints are NOT routed through the quoter, and why.
 *
 * The list is here rather than in a regex so that an exemption costs a line of
 * prose. `pod extract.ts` is the repository's one CRLF-terminated source file
 * and a normalizing edit to it produces a whole-file phantom diff, so its two
 * hint lines are left for a change that can be made with the line endings
 * preserved. They are recorded here so they are a known debt rather than an
 * omission this gate silently permits.
 */
const UNQUOTED_HINT_EXEMPTIONS: ReadonlySet<string> = new Set(['extract.ts']);

/**
 * Whether one source line prints a `cascade …` command with a value spliced into
 * the command ITSELF.
 *
 * The "into the command itself" part is the whole test. Half the verbs print
 * `Pod not found at ${podDir} … Run 'cascade pod init' first`, where the hole is
 * in the prose and the command carries no argument at all; flagging those would
 * make the gate noise. So the interpolation has to appear AFTER the `cascade`
 * token on the line, which is where an argument would go.
 */
function splicesIntoCommand(line: string): boolean {
  if (/^\s*(\*|\/\/)/.test(line)) return false;
  if (/shellCommand\(|shellQuote\(/.test(line)) return false;
  const m = /cascade (pod|agent|validate|convert|query) /.exec(line);
  if (!m) return false;
  const after = line.slice(m.index + m[0].length);
  // A template hole, or a string concatenation that appends a value.
  return /\$\{/.test(after) || /['"`]\s*\+\s*\w/.test(after);
}

describe('no verb interpolates a raw path into a suggested command', () => {
  it('routes every `cascade …` hint through the quoter', () => {
    const dir = path.join(REPO, 'src', 'commands', 'pod');
    const offenders: string[] = [];

    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.ts')) continue;
      if (UNQUOTED_HINT_EXEMPTIONS.has(name)) continue;
      const lines = fs.readFileSync(path.join(dir, name), 'utf-8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (splicesIntoCommand(lines[i])) offenders.push(`${name}:${i + 1}: ${lines[i].trim()}`);
      }
    }

    expect(
      offenders,
      `these lines interpolate a value into a suggested command without quoting it.\n` +
        `Route them through shellCommand() from src/lib/shell-quote.js, or add the file to\n` +
        `UNQUOTED_HINT_EXEMPTIONS with the reason:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no exemption for a file that no longer needs one', () => {
    // An exemption that outlives its reason is how a gate rots into decoration.
    for (const name of UNQUOTED_HINT_EXEMPTIONS) {
      const p = path.join(REPO, 'src', 'commands', 'pod', name);
      expect(fs.existsSync(p), `exempted file ${name} does not exist`).toBe(true);
      const stillOffends = fs
        .readFileSync(p, 'utf-8')
        .split(/\r?\n/)
        .some((l) => splicesIntoCommand(l));
      expect(stillOffends, `${name} is exempted but no longer has an unquoted hint`).toBe(true);
    }
  });
});
