/**
 * cascade validate <file-or-dir>
 *
 * Validate Cascade Protocol data against SHACL shapes.
 *
 * Options:
 *   --shapes <shapes-dir>  Path to custom SHACL shapes directory
 *   --json                 Output results as JSON
 *   --verbose              Show detailed validation information
 *
 * Exit codes:
 *   0 = all files pass validation
 *   1 = one or more validation failures
 *   2 = errors (file not found, malformed Turtle, etc.)
 *
 * Subjects that no loaded shape applies to are counted and named in the output
 * but do NOT affect the exit code. An unshaped subject means the vocabulary has
 * no constraints for that class yet, which is a gap in the shapes rather than a
 * defect in the data being validated, and failing on it would break every
 * existing caller on upgrade for something they cannot fix in their own data.
 * The count is reported on every file so the gap cannot pass unnoticed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { printVerbose, type OutputOptions } from '../lib/output.js';
import {
  loadShapes,
  validateFile,
  findTurtleFiles,
  failsValidation,
  type ValidationResult,
} from '../lib/shacl-validator.js';
import { shortenIRI } from '../lib/turtle-parser.js';
import { isPodEncrypted, resolveDek, PodDecryptError } from '../lib/pod-encryption.js';
import { obtainPassphrase } from '../lib/passphrase.js';
import { toJsonText } from '../lib/json-output.js';

/** ANSI color codes for terminal output */
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

/** Severity icons for human-readable output */
const severityIcons: Record<string, string> = {
  violation: `${colors.red}FAIL${colors.reset}`,
  warning: `${colors.yellow}WARN${colors.reset}`,
  info: `${colors.blue}INFO${colors.reset}`,
};

/**
 * Describe how much of a file the loaded shapes actually reached.
 *
 * Rendered on every result line, passing or failing, because a file with no
 * applicable shape produces a conforming SHACL report while running zero
 * constraints, and the count is the only thing that distinguishes "checked and
 * correct" from "not checked".
 */
function formatCoverage(result: ValidationResult): { summary: string; detail?: string } {
  const { totalSubjects, checkedSubjects, unshapedTypes } = result.coverage;

  if (totalSubjects === 0) {
    return { summary: 'no typed subjects' };
  }

  const unshapedCount = totalSubjects - checkedSubjects;
  const checked = `${checkedSubjects} of ${totalSubjects} subject${totalSubjects !== 1 ? 's' : ''} checked`;

  if (unshapedCount === 0) {
    return { summary: checked };
  }

  const plural = unshapedCount !== 1 ? 's' : '';

  // A single unshaped type fits on the result line; several need their own.
  if (unshapedTypes.length === 1) {
    const type = shortenIRI(unshapedTypes[0].type);
    return {
      summary: `${checked}; ${unshapedCount} subject${plural} of type ${type} had no applicable shape`,
    };
  }

  const breakdown = unshapedTypes
    .map((t) => `${shortenIRI(t.type)} (${t.count})`)
    .join(', ');
  return {
    summary: `${checked}; ${unshapedCount} subject${plural} had no applicable shape`,
    detail: `     No shape applies to: ${breakdown}`,
  };
}

/**
 * Format a single validation result for human-readable output.
 */
function formatResultHuman(result: ValidationResult, verbose: boolean): string {
  const lines: string[] = [];
  const relPath = result.file;
  const coverage = formatCoverage(result);

  if (result.results.length === 0) {
    lines.push(
      `${colors.green}PASS${colors.reset} ${relPath} (${result.quadCount} triples; ${coverage.summary})`,
    );
    if (coverage.detail) {
      lines.push(coverage.detail);
    }
    if (verbose && result.shapesUsed.length > 0) {
      lines.push(`     Shapes: ${result.shapesUsed.join(', ')}`);
    }
    if (verbose && result.subjects.length > 0) {
      const typesSummary = result.subjects
        .flatMap((s) => s.types.map(uriToLocalName))
        .filter((t, i, a) => a.indexOf(t) === i);
      lines.push(`     Types: ${typesSummary.join(', ')}`);
    }
  } else {
    const violations = result.results.filter((r) => r.severity === 'violation');
    const warnings = result.results.filter((r) => r.severity === 'warning');
    const infos = result.results.filter((r) => r.severity === 'info');

    const countParts: string[] = [];
    if (violations.length > 0) countParts.push(`${violations.length} violation${violations.length !== 1 ? 's' : ''}`);
    if (warnings.length > 0) countParts.push(`${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`);
    if (infos.length > 0) countParts.push(`${infos.length} info`);

    // Status tracks severity, not `sh:conforms`. An Info-only file conforms to
    // nothing in the SHACL sense (`sh:conforms` is false the moment any result
    // exists) but has no defect to report, so it reads PASS and lists its
    // advisories underneath. See `failsValidation`.
    const statusIcon = violations.length > 0
      ? `${colors.red}FAIL${colors.reset}`
      : warnings.length > 0
        ? `${colors.yellow}WARN${colors.reset}`
        : `${colors.green}PASS${colors.reset}`;

    lines.push(
      `${statusIcon} ${relPath} (${result.quadCount} triples, ${countParts.join(', ')}; ${coverage.summary})`,
    );

    if (coverage.detail) {
      lines.push(coverage.detail);
    }

    if (result.shapesUsed.length > 0) {
      lines.push(`     Shapes: ${result.shapesUsed.join(', ')}`);
    }

    // Group issues by severity
    for (const issue of result.results) {
      const icon = severityIcons[issue.severity] ?? issue.severity;
      const focusInfo = issue.focusNode ? ` [${uriToLocalName(issue.focusNode)}]` : '';
      lines.push(`  ${icon} ${issue.message}${focusInfo}`);
      if (issue.property) {
        lines.push(`       Property: ${issue.property}`);
      }
      if (issue.shape) {
        lines.push(`       Shape: ${issue.shape}`);
      }
      if (issue.value !== undefined) {
        lines.push(`       Value: ${issue.value}`);
      }
      if (issue.specLink) {
        lines.push(`       Spec: ${colors.cyan}${issue.specLink}${colors.reset}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Extract local name from a URI (fragment or last path segment).
 */
function uriToLocalName(uri: string): string {
  if (uri.includes('#')) {
    return uri.split('#').pop() ?? uri;
  }
  return uri.split('/').pop() ?? uri;
}

/**
 * Print a summary line for batch validation.
 */
function printSummary(
  results: ValidationResult[],
  opts: OutputOptions,
): void {
  if (opts.json) return; // JSON mode outputs the full array

  const total = results.length;
  // Keyed on severity, not on `sh:conforms`, so this column agrees with the
  // process exit code. Both say "failure" only for `sh:Violation`.
  const failed = results.filter(failsValidation).length;
  const passed = total - failed;

  const totalViolations = results.reduce(
    (sum, r) => sum + r.results.filter((i) => i.severity === 'violation').length,
    0,
  );
  const totalWarnings = results.reduce(
    (sum, r) => sum + r.results.filter((i) => i.severity === 'warning').length,
    0,
  );
  const totalInfos = results.reduce(
    (sum, r) => sum + r.results.filter((i) => i.severity === 'info').length,
    0,
  );

  console.log('');
  console.log(`${colors.bold}Validation Summary${colors.reset}`);
  console.log(`  Files: ${total} total, ${colors.green}${passed} passed${colors.reset}, ${failed > 0 ? `${colors.red}${failed} failed${colors.reset}` : '0 failed'}`);

  const parts: string[] = [];
  if (totalViolations > 0) parts.push(`${colors.red}${totalViolations} violations${colors.reset}`);
  if (totalWarnings > 0) parts.push(`${colors.yellow}${totalWarnings} warnings${colors.reset}`);
  if (totalInfos > 0) parts.push(`${colors.blue}${totalInfos} info${colors.reset}`);
  if (parts.length > 0) {
    console.log(`  Issues: ${parts.join(', ')}`);
  }

  const totalSubjects = results.reduce((sum, r) => sum + r.coverage.totalSubjects, 0);
  const checkedSubjects = results.reduce((sum, r) => sum + r.coverage.checkedSubjects, 0);
  const unshaped = totalSubjects - checkedSubjects;

  if (totalSubjects > 0) {
    const coverageLine = `  Coverage: ${checkedSubjects} of ${totalSubjects} subjects checked`;
    if (unshaped === 0) {
      console.log(coverageLine);
    } else {
      console.log(`${coverageLine}, ${colors.yellow}${unshaped} with no applicable shape${colors.reset}`);

      // Roll the per-file breakdowns into one list so a repeated gap reads as
      // one vocabulary hole rather than N unrelated file problems.
      const byType = new Map<string, number>();
      for (const r of results) {
        for (const t of r.coverage.unshapedTypes) {
          byType.set(t.type, (byType.get(t.type) ?? 0) + t.count);
        }
      }
      const ranked = Array.from(byType.entries())
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
        .map(([type, count]) => `${shortenIRI(type)} (${count})`);
      console.log(`  No shape applies to: ${ranked.join(', ')}`);
    }
  }
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate Cascade data against SHACL shapes')
    .argument('<file-or-dir>', 'Turtle file or directory to validate')
    .option('--shapes <shapes-dir>', 'Path to custom SHACL shapes directory')
    .action(async (fileOrDir: string, options: { shapes?: string }) => {
      const globalOpts = program.opts() as OutputOptions;

      // Resolve the path
      const targetPath = path.resolve(fileOrDir);

      // Check if path exists
      if (!fs.existsSync(targetPath)) {
        if (globalOpts.json) {
          console.log(toJsonText({ error: `Path not found: ${targetPath}` }));
        } else {
          console.error(`${colors.red}ERROR${colors.reset}: Path not found: ${targetPath}`);
        }
        process.exitCode = 2;
        return;
      }

      // Load SHACL shapes
      printVerbose('Loading SHACL shapes...', globalOpts);

      let shapesStore;
      let shapeFiles: string[];
      try {
        const loaded = loadShapes(options.shapes);
        shapesStore = loaded.store;
        shapeFiles = loaded.shapeFiles;
        printVerbose(`Loaded ${shapeFiles.length} shape files: ${shapeFiles.join(', ')}`, globalOpts);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (globalOpts.json) {
          console.log(toJsonText({ error: msg }));
        } else {
          console.error(`${colors.red}ERROR${colors.reset}: ${msg}`);
        }
        process.exitCode = 2;
        return;
      }

      // If validating an encrypted pod directory, resolve the DEK up front so
      // each file can be decrypted before SHACL parsing.
      let dek: Buffer | undefined;
      if (fs.statSync(targetPath).isDirectory() && isPodEncrypted(targetPath)) {
        try {
          const passphrase = await obtainPassphrase();
          dek = resolveDek(targetPath, passphrase);
          printVerbose('Pod is encrypted; decrypting resources for validation.', globalOpts);
        } catch (e: unknown) {
          const msg =
            e instanceof PodDecryptError ? e.message : e instanceof Error ? e.message : String(e);
          if (globalOpts.json) {
            console.log(toJsonText({ error: `Cannot read encrypted pod: ${msg}` }));
          } else {
            console.error(`${colors.red}ERROR${colors.reset}: Cannot read encrypted pod: ${msg}`);
          }
          process.exitCode = 2;
          return;
        }
      }

      // Determine files to validate
      let filesToValidate: string[];
      const stat = fs.statSync(targetPath);

      if (stat.isDirectory()) {
        filesToValidate = findTurtleFiles(targetPath);
        if (filesToValidate.length === 0) {
          if (globalOpts.json) {
            console.log(toJsonText({ error: `No .ttl files found in ${targetPath}` }));
          } else {
            console.error(`${colors.yellow}WARNING${colors.reset}: No .ttl files found in ${targetPath}`);
          }
          process.exitCode = 2;
          return;
        }
        printVerbose(`Found ${filesToValidate.length} Turtle files in ${targetPath}`, globalOpts);
      } else if (stat.isFile()) {
        if (!targetPath.endsWith('.ttl')) {
          if (globalOpts.json) {
            console.log(toJsonText({ error: `Not a Turtle file: ${targetPath}` }));
          } else {
            console.error(`${colors.red}ERROR${colors.reset}: Not a Turtle file (expected .ttl): ${targetPath}`);
          }
          process.exitCode = 2;
          return;
        }
        filesToValidate = [targetPath];
      } else {
        if (globalOpts.json) {
          console.log(toJsonText({ error: `Not a file or directory: ${targetPath}` }));
        } else {
          console.error(`${colors.red}ERROR${colors.reset}: Not a file or directory: ${targetPath}`);
        }
        process.exitCode = 2;
        return;
      }

      // Validate each file
      const results: ValidationResult[] = [];
      let hasErrors = false;
      let hasViolations = false;

      for (const file of filesToValidate) {
        printVerbose(`Validating: ${file}`, globalOpts);

        try {
          const result = validateFile(file, shapesStore, shapeFiles, dek);
          results.push(result);

          if (failsValidation(result)) {
            hasViolations = true;
          }

          // Print result immediately in human-readable mode
          if (!globalOpts.json) {
            console.log(formatResultHuman(result, globalOpts.verbose));
          }
        } catch (e: unknown) {
          hasErrors = true;
          const msg = e instanceof Error ? e.message : String(e);
          const errorResult: ValidationResult = {
            valid: false,
            file,
            results: [{
              severity: 'violation',
              shape: '',
              property: '',
              message: `Error processing file: ${msg}`,
            }],
            shapesUsed: [],
            shapesFired: [],
            quadCount: 0,
            subjects: [],
            coverage: {
              totalSubjects: 0,
              checkedSubjects: 0,
              unshapedSubjects: [],
              unshapedTypes: [],
            },
          };
          results.push(errorResult);
          if (!globalOpts.json) {
            console.log(formatResultHuman(errorResult, globalOpts.verbose));
          }
        }
      }

      // Output JSON
      if (globalOpts.json) {
        console.log(toJsonText(results));
      } else {
        // Print summary for multiple files
        if (results.length > 1) {
          printSummary(results, globalOpts);
        }
      }

      // Set exit code
      if (hasErrors) {
        process.exitCode = 2;
      } else if (hasViolations) {
        process.exitCode = 1;
      } else {
        process.exitCode = 0;
      }
    });
}
