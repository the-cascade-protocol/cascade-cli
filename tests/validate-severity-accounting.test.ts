/**
 * A file fails validation when it carries a Violation, and not otherwise.
 *
 * WHAT WENT WRONG
 * ---------------
 * `ValidationResult.valid` was the SHACL `sh:conforms` value verbatim, and per
 * [SHACL 3.2](https://www.w3.org/TR/shacl/#validation-report) that is `false`
 * whenever the report carries ANY result, at any severity. The summary computed
 * `passed = results.filter(r => r.valid).length`, so a file whose only finding
 * was an `sh:Info` advisory was printed `WARN` and counted under **failed**.
 *
 * Meanwhile the exit code was computed from violations alone. So on a pod with
 * zero violations and four Info advisories, `cascade validate` printed
 * `19 total, 15 passed, 4 failed` and exited **0** — the tally and the exit code
 * asserting opposite things about the same run. Whichever one the caller
 * trusted, the other was lying to them.
 *
 * That is not cosmetic. It lands hardest exactly when a release adds
 * constraints: the message is that new findings mean the validator improved, not
 * that the data broke, and `4 failed` on a pod with no defects contradicts it in
 * the first line anyone reads.
 *
 * THE RULE, AND WHY WARNING SITS WHERE IT DOES
 * --------------------------------------------
 * A file fails if and only if it carries at least one Violation. Warning and
 * Info do not fail it. That is not a judgement about how serious a warning is —
 * it is forced by the exit code, which has always been violations-only. Any
 * other choice re-creates the original defect in a new place: make Warning fail
 * the tally and a warning-only run once again reports failures while exiting 0.
 * The two must agree, and the exit code is the one with existing callers.
 *
 * WHAT THESE WOULD DO IF THE FIX WERE ABSENT — measured against 1750f16,
 * 6 of the 10 fail:
 *   - `counts an Info-only file as passed` FAILS: `2 total, 1 passed, 1 failed`.
 *   - `prints PASS for an Info-only file` FAILS: prints `WARN`.
 *   - `counts a Warning-only file as passed` FAILS: `2 total, 1 passed, 1 failed`.
 *   - `tallies a mixed directory by violations alone` FAILS:
 *     `4 total, 1 passed, 3 failed` for one violation.
 *   - `agrees with its own exit code` FAILS on the Info-only directory: the
 *     summary says 1 failed and the process exits 0.
 *   - `reports genuinely different inputs differently` FAILS: the Info-only run
 *     reports a failure, so it no longer differs from the violation run in the
 *     way that matters.
 *
 * And 4 pass against the broken build, deliberately:
 *   - the fixture self-check, which is about the fixture and not the fix;
 *   - `prints WARN for a Warning-only file`, unchanged behaviour;
 *   - `counts a Violation file as failed`, the control that distinguishes
 *     "accounting fixed" from "accounting removed";
 *   - determinism, which is orthogonal to severity.
 *
 * The fixtures are authored here rather than taken from the bundled shapes, so
 * this cannot silently stop testing anything when the vocabulary changes: the
 * bundled shapes' Info constraints are a moving target, and a test that depends
 * on one existing is a test that quietly evaporates when it is retired.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'index.js');

const SHAPES = `
@prefix sh:   <http://www.w3.org/ns/shacl#> .
@prefix ex:   <https://example.org/severity#> .

ex:InfoShape a sh:NodeShape ;
    sh:targetClass ex:InfoSubject ;
    sh:property [
        sh:path ex:detail ;
        sh:minCount 1 ;
        sh:severity sh:Info ;
        sh:message "Consider recording the optional detail."
    ] .

ex:WarningShape a sh:NodeShape ;
    sh:targetClass ex:WarningSubject ;
    sh:property [
        sh:path ex:detail ;
        sh:minCount 1 ;
        sh:severity sh:Warning ;
        sh:message "The detail is usually present."
    ] .

ex:ViolationShape a sh:NodeShape ;
    sh:targetClass ex:ViolationSubject ;
    sh:property [
        sh:path ex:detail ;
        sh:minCount 1 ;
        sh:severity sh:Violation ;
        sh:message "The detail is required."
    ] .

ex:CleanShape a sh:NodeShape ;
    sh:targetClass ex:CleanSubject ;
    sh:property [
        sh:path ex:detail ;
        sh:minCount 1 ;
        sh:severity sh:Violation ;
        sh:message "The detail is required."
    ] .
`;

/** Each subject omits ex:detail, so its shape fires at exactly its severity. */
const DATA: Record<string, string> = {
  info: '@prefix ex: <https://example.org/severity#> .\nex:a a ex:InfoSubject .\n',
  warning: '@prefix ex: <https://example.org/severity#> .\nex:b a ex:WarningSubject .\n',
  violation: '@prefix ex: <https://example.org/severity#> .\nex:c a ex:ViolationSubject .\n',
  clean: '@prefix ex: <https://example.org/severity#> .\nex:d a ex:CleanSubject ; ex:detail "present" .\n',
};

let root: string;
let shapesDir: string;

/** One directory per severity, plus one holding all four. */
function dataDir(...names: string[]): string {
  const dir = path.join(root, `data-${names.join('-')}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(dir, `${n}.ttl`), DATA[n]);
  }
  return dir;
}

function validate(target: string): { out: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, 'validate', target, '--shapes', shapesDir], {
    encoding: 'utf-8',
    timeout: 120000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  return {
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, ''),
    status: r.status ?? -1,
  };
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error('dist/index.js is missing — run `npm run build` before `npm test`.');
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'severity-accounting-'));
  shapesDir = path.join(root, 'shapes');
  fs.mkdirSync(shapesDir);
  fs.writeFileSync(path.join(shapesDir, 'severity.shapes.ttl'), SHAPES);
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('the severity fixture itself', () => {
  it('produces one finding at each severity — otherwise this file proves nothing', () => {
    const { out } = validate(dataDir('info', 'warning', 'violation', 'clean'));
    expect(out).toMatch(/1 violation/);
    expect(out).toMatch(/1 warning/);
    expect(out).toMatch(/1 info/);
    expect(out).toContain('Consider recording the optional detail.');
    expect(out).toContain('The detail is usually present.');
    expect(out).toContain('The detail is required.');
  });
});

describe('cascade validate severity accounting', () => {
  it('counts an Info-only file as passed, not failed', () => {
    const { out } = validate(dataDir('info', 'clean'));
    expect(out).toMatch(/2 total, 2 passed, 0 failed/);
  });

  it('prints PASS for an Info-only file and still lists the advisory', () => {
    const { out } = validate(dataDir('info', 'clean'));
    const line = out.split('\n').find((l) => l.includes('info.ttl') && /^(PASS|WARN|FAIL)/.test(l));
    expect(line, out).toBeDefined();
    expect(line).toMatch(/^PASS/);
    // Reporting it as a pass must not mean hiding it.
    expect(out).toContain('Consider recording the optional detail.');
  });

  it('counts a Warning-only file as passed', () => {
    const { out } = validate(dataDir('warning', 'clean'));
    expect(out).toMatch(/2 total, 2 passed, 0 failed/);
  });

  it('prints WARN for a Warning-only file', () => {
    const { out } = validate(dataDir('warning', 'clean'));
    const line = out
      .split('\n')
      .find((l) => l.includes('warning.ttl') && /^(PASS|WARN|FAIL)/.test(l));
    expect(line, out).toBeDefined();
    expect(line).toMatch(/^WARN/);
  });

  it('counts a Violation file as failed', () => {
    // The control. If the change had simply stopped counting failures, this
    // would break; it is what distinguishes "accounting fixed" from "accounting
    // removed".
    const { out } = validate(dataDir('violation', 'clean'));
    expect(out).toMatch(/2 total, 1 passed, 1 failed/);
    const line = out
      .split('\n')
      .find((l) => l.includes('violation.ttl') && /^(PASS|WARN|FAIL)/.test(l));
    expect(line).toMatch(/^FAIL/);
  });

  it('tallies a mixed directory by violations alone', () => {
    const { out } = validate(dataDir('info', 'warning', 'violation', 'clean'));
    expect(out).toMatch(/4 total, 3 passed, 1 failed/);
  });

  it('agrees with its own exit code', () => {
    // The defect in one assertion: the summary and the exit code have to be
    // answering the same question.
    for (const [names, expectedFailed, expectedStatus] of [
      [['info', 'clean'], 0, 0],
      [['warning', 'clean'], 0, 0],
      [['violation', 'clean'], 1, 1],
      [['info', 'warning', 'violation', 'clean'], 1, 1],
    ] as const) {
      const { out, status } = validate(dataDir(...names));
      const m = out.match(/(\d+) total, (\d+) passed, (\d+) failed/);
      expect(m, `no summary for ${names.join('+')}:\n${out}`).not.toBeNull();
      expect(Number(m![3]), `failed count for ${names.join('+')}`).toBe(expectedFailed);
      expect(status, `exit code for ${names.join('+')}`).toBe(expectedStatus);
      // The invariant the two must share, stated directly.
      expect(Number(m![3]) > 0, `tally/exit disagreement for ${names.join('+')}`).toBe(
        status === 1,
      );
    }
  });

  it('is deterministic across processes and working directories', () => {
    const dir = dataDir('info', 'warning', 'violation', 'clean');
    const run = (cwd: string) => {
      const r = spawnSync(process.execPath, [CLI, 'validate', dir, '--shapes', shapesDir], {
        encoding: 'utf-8',
        cwd,
        timeout: 120000,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      });
      return `${r.stdout ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '');
    };
    expect(run('/')).toBe(run(REPO));
  });

  it('reports genuinely different inputs differently', () => {
    const infoOnly = validate(dataDir('info', 'clean')).out;
    const violationOnly = validate(dataDir('violation', 'clean')).out;
    expect(infoOnly).not.toBe(violationOnly);
    expect(infoOnly).toMatch(/0 failed/);
    expect(violationOnly).toMatch(/1 failed/);
  });
});
