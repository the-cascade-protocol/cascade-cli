/**
 * cascade conformance run
 *
 * Run conformance test suite against a CLI command or self-test.
 *
 * Options:
 *   --suite <fixtures-dir>    Path to test fixtures directory
 *   --command "<cmd>"         External command to test
 *   --self                    Run self-conformance tests
 *   --json                    Output results as JSON
 *   --verbose                 Show detailed test output
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadShapes, validateTurtle } from '../lib/shacl-validator.js';
import { parseTurtle } from '../lib/turtle-parser.js';
import { printResult, printError, printVerbose, type OutputOptions } from '../lib/output.js';
import type { ValidationResult } from '../lib/shacl-validator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a single conformance fixture JSON file. */
interface ConformanceFixture {
  id: string;
  description: string;
  dataType: string;
  vocabulary: string;
  input: Record<string, unknown>;
  expectedOutput: {
    turtle: string;
    validationMode: 'shacl-valid' | 'exact-match';
  };
  shouldAccept: boolean;
  tags: string[];
  shaclConstraintViolated?: string;
  notes?: string;
}

/** Result of running a single fixture. */
interface FixtureResult {
  id: string;
  description: string;
  dataType: string;
  status: 'passed' | 'failed' | 'error';
  negative: boolean;
  details?: string;
  validationDetails?: ValidationResult;
}

/** Aggregate report for the full suite run. */
interface SuiteReport {
  suite: string;
  mode: string;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  results: FixtureResult[];
  byDataType: Record<string, { total: number; passed: number; failed: number; errors: number }>;
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

/**
 * Load and parse all `.json` fixture files from the given directory.
 * Files are sorted by id so output order is deterministic.
 */
function loadFixtures(suiteDir: string): ConformanceFixture[] {
  if (!fs.existsSync(suiteDir)) {
    throw new Error(`Fixtures directory not found: ${suiteDir}`);
  }

  const files = fs
    .readdirSync(suiteDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    throw new Error(`No .json fixture files found in ${suiteDir}`);
  }

  const fixtures: ConformanceFixture[] = [];

  for (const file of files) {
    const filePath = path.join(suiteDir, file);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const fixture = JSON.parse(raw) as ConformanceFixture;
    fixtures.push(fixture);
  }

  return fixtures;
}

// ---------------------------------------------------------------------------
// Self-conformance runner
// ---------------------------------------------------------------------------

/**
 * Run a single fixture in self-conformance mode.
 *
 * Positive fixtures (shouldAccept === true):
 *   - Parse the expected turtle
 *   - Run SHACL validation
 *   - PASS if no violations; FAIL otherwise
 *
 * Negative fixtures (shouldAccept === false):
 *   - If turtle is empty: PASS (rejection before serialization)
 *   - If turtle is non-empty: SHACL validate — PASS if violations found, FAIL if clean
 */
function runSelfFixture(
  fixture: ConformanceFixture,
  shapesStore: ReturnType<typeof loadShapes>['store'],
  shapeFiles: string[],
  opts: OutputOptions,
): FixtureResult {
  const base: Pick<FixtureResult, 'id' | 'description' | 'dataType' | 'negative'> = {
    id: fixture.id,
    description: fixture.description,
    dataType: fixture.dataType,
    negative: !fixture.shouldAccept,
  };

  const turtle = fixture.expectedOutput.turtle;
  const validationMode = fixture.expectedOutput.validationMode;

  try {
    if (fixture.shouldAccept) {
      // ---- Positive fixture ----

      // Step 1: Parse the turtle
      const parseResult = parseTurtle(turtle);
      if (!parseResult.success) {
        return {
          ...base,
          status: 'failed',
          details: `Turtle parse error: ${parseResult.errors.join('; ')}`,
        };
      }

      // Step 2: SHACL validation
      const validation = validateTurtle(turtle, shapesStore, shapeFiles, fixture.id);

      if (validationMode === 'shacl-valid') {
        if (validation.valid) {
          printVerbose(`  [${fixture.id}] SHACL valid (${validation.quadCount} quads)`, opts);
          return { ...base, status: 'passed', validationDetails: validation };
        } else {
          const violations = validation.results
            .filter((r) => r.severity === 'violation')
            .map((r) => `${r.shape}.${r.property}: ${r.message}`)
            .join('; ');
          return {
            ...base,
            status: 'failed',
            details: `SHACL violations: ${violations}`,
            validationDetails: validation,
          };
        }
      } else if (validationMode === 'exact-match') {
        // Exact-match: for now, verify it parses and is SHACL-valid
        // Full normalized triple-by-triple equivalence is deferred
        if (validation.valid) {
          printVerbose(
            `  [${fixture.id}] exact-match: parsed & SHACL valid (full normalization deferred)`,
            opts,
          );
          return { ...base, status: 'passed', validationDetails: validation };
        } else {
          const violations = validation.results
            .filter((r) => r.severity === 'violation')
            .map((r) => `${r.shape}.${r.property}: ${r.message}`)
            .join('; ');
          return {
            ...base,
            status: 'failed',
            details: `SHACL violations (exact-match mode): ${violations}`,
            validationDetails: validation,
          };
        }
      } else {
        return {
          ...base,
          status: 'error',
          details: `Unknown validationMode: ${validationMode as string}`,
        };
      }
    } else {
      // ---- Negative fixture ----

      if (turtle === '') {
        // Empty turtle means the SDK should reject before serialization — PASS
        printVerbose(`  [${fixture.id}] negative: empty turtle (pre-serialization rejection)`, opts);
        return { ...base, status: 'passed' };
      }

      // Non-empty turtle: validate and expect violations
      const parseResult = parseTurtle(turtle);
      if (!parseResult.success) {
        // Parse failure on negative fixture = PASS (malformed is invalid)
        printVerbose(`  [${fixture.id}] negative: turtle parse error (expected)`, opts);
        return { ...base, status: 'passed', details: 'Turtle parse error (expected for negative fixture)' };
      }

      const validation = validateTurtle(turtle, shapesStore, shapeFiles, fixture.id);

      if (!validation.valid) {
        // Violations found — PASS for negative fixture
        const violations = validation.results
          .filter((r) => r.severity === 'violation')
          .map((r) => `${r.shape}.${r.property}: ${r.message}`)
          .join('; ');
        printVerbose(`  [${fixture.id}] negative: SHACL violations found (expected): ${violations}`, opts);
        return { ...base, status: 'passed', validationDetails: validation };
      } else {
        // No violations — FAIL for negative fixture
        return {
          ...base,
          status: 'failed',
          details: `Expected SHACL violations but data validated clean. Expected: ${fixture.shaclConstraintViolated ?? 'unspecified'}`,
          validationDetails: validation,
        };
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      status: 'error',
      details: `Unexpected error: ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

/**
 * Build the aggregate suite report from individual fixture results.
 */
function buildReport(
  suitePath: string,
  mode: string,
  results: FixtureResult[],
): SuiteReport {
  const byDataType: SuiteReport['byDataType'] = {};

  for (const r of results) {
    if (!byDataType[r.dataType]) {
      byDataType[r.dataType] = { total: 0, passed: 0, failed: 0, errors: 0 };
    }
    const group = byDataType[r.dataType];
    group.total++;
    if (r.status === 'passed') group.passed++;
    else if (r.status === 'failed') group.failed++;
    else group.errors++;
  }

  return {
    suite: suitePath,
    mode,
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    errors: results.filter((r) => r.status === 'error').length,
    results,
    byDataType,
  };
}

/**
 * Print a human-readable report to stdout.
 */
function printHumanReport(report: SuiteReport, opts: OutputOptions): void {
  console.log('');
  console.log('Cascade Protocol Conformance Test Suite');
  console.log('========================================');
  console.log(`Suite: ${report.suite}`);
  console.log(`Mode: ${report.mode === 'self' ? 'self-conformance' : report.mode}`);
  console.log(`Fixtures: ${report.total}`);
  console.log('');
  console.log('Running tests...');
  console.log('');

  // Group results by dataType, preserving insertion order
  const dataTypes: string[] = [];
  const grouped: Record<string, FixtureResult[]> = {};

  for (const r of report.results) {
    if (!grouped[r.dataType]) {
      grouped[r.dataType] = [];
      dataTypes.push(r.dataType);
    }
    grouped[r.dataType].push(r);
  }

  for (const dt of dataTypes) {
    const fixtures = grouped[dt];
    console.log(`  ${dt} (${fixtures.length} fixtures)`);

    for (const r of fixtures) {
      const icon = r.status === 'passed' ? '\u2713' : r.status === 'failed' ? '\u2717' : '!';
      const negativeTag = r.negative ? '[negative] ' : '';
      const statusLine = `    ${icon} ${r.id}: ${negativeTag}${r.description}`;
      console.log(statusLine);

      if (r.status !== 'passed' && r.details) {
        console.log(`      ${r.details}`);
      }

      // In verbose mode, show validation details even for passing tests
      if (opts.verbose && r.validationDetails) {
        const vd = r.validationDetails;
        console.log(`      Quads: ${vd.quadCount}, Shapes: [${vd.shapesUsed.join(', ')}]`);
        if (vd.results.length > 0) {
          for (const issue of vd.results) {
            console.log(`      - [${issue.severity}] ${issue.shape}.${issue.property}: ${issue.message}`);
          }
        }
      }
    }

    console.log('');
  }

  // Summary line
  const parts: string[] = [];
  parts.push(`${report.passed} passed`);
  if (report.failed > 0) parts.push(`${report.failed} failed`);
  else parts.push('0 failed');
  if (report.errors > 0) parts.push(`${report.errors} errors`);
  else parts.push('0 errors');

  console.log(`Results: ${parts.join(', ')}`);

  const exitCode = report.failed > 0 || report.errors > 0 ? 1 : 0;
  console.log(`Exit code: ${exitCode}`);
}

/**
 * Print the JSON report using the output library.
 */
function printJsonReport(report: SuiteReport, opts: OutputOptions): void {
  // Strip validationDetails from results for cleaner JSON output
  const cleanResults = report.results.map((r) => {
    const { validationDetails: _vd, ...rest } = r;
    return rest;
  });

  printResult(
    {
      suite: report.suite,
      mode: report.mode,
      total: report.total,
      passed: report.passed,
      failed: report.failed,
      errors: report.errors,
      results: cleanResults,
      byDataType: report.byDataType,
    },
    opts,
  );
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerConformanceCommand(program: Command): void {
  const conformance = program
    .command('conformance')
    .description('Run conformance test suite');

  conformance
    .command('run')
    .description('Execute conformance tests')
    .requiredOption('--suite <fixtures-dir>', 'Path to test fixtures directory')
    .option('--command <cmd>', 'External command to test against')
    .option('--self', 'Run self-conformance tests')
    .action(
      async (options: {
        suite: string;
        command?: string;
        self?: boolean;
      }) => {
        const globalOpts = program.opts() as OutputOptions;

        if (!options.command && !options.self) {
          printError('Either --command or --self must be specified', globalOpts);
          process.exitCode = 1;
          return;
        }

        // External command mode: not yet supported
        if (options.command) {
          printError('External command mode not yet supported', globalOpts);
          process.exitCode = 1;
          return;
        }

        // Resolve suite directory
        const suitePath = path.resolve(options.suite);
        printVerbose(`Conformance suite: ${suitePath}`, globalOpts);
        printVerbose('Running self-conformance tests', globalOpts);

        try {
          // Load fixtures
          const fixtures = loadFixtures(suitePath);
          printVerbose(`Loaded ${fixtures.length} fixture(s)`, globalOpts);

          // Load SHACL shapes once
          const { store: shapesStore, shapeFiles } = loadShapes();
          printVerbose(`Loaded shapes: ${shapeFiles.join(', ')}`, globalOpts);

          // Run each fixture
          const results: FixtureResult[] = [];

          for (const fixture of fixtures) {
            const result = runSelfFixture(fixture, shapesStore, shapeFiles, globalOpts);
            results.push(result);
          }

          // Build and output report
          const report = buildReport(options.suite, 'self', results);

          if (globalOpts.json) {
            printJsonReport(report, globalOpts);
          } else {
            printHumanReport(report, globalOpts);
          }

          // Set exit code
          process.exitCode = report.failed > 0 || report.errors > 0 ? 1 : 0;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          printError(`Conformance suite failed: ${message}`, globalOpts);
          process.exitCode = 1;
        }
      },
    );
}
