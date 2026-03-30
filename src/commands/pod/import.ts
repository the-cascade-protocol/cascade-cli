/**
 * cascade pod import <pod-dir> <files...>
 *
 * Import FHIR JSON or Cascade Turtle files into a Cascade Pod.
 *
 * Converts FHIR to Cascade Turtle if needed, optionally reconciles multiple
 * inputs, routes records by type to the correct pod data files, updates type
 * indexes, and appends ldp:contains references to index.ttl.
 *
 * Options:
 *   --source-system <name>   Tag all records with this system name
 *   --no-reconcile           Skip reconciliation even with multiple files
 *   --trust <scores>         Trust scores e.g. hospital=0.95,clinic=0.85
 *   --dry-run                Preview without writing any files
 *   --report <file>          Write import report JSON to file
 *   --passthrough <mode>     Passthrough mode: full|minimal (default: full)
 */

import type { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Parser } from 'n3';
import type { Quad } from 'n3';
import { printResult, printError, printVerbose, type OutputOptions } from '../../lib/output.js';
import { convert } from '../../lib/fhir-converter/index.js';
import { quadsToTurtle } from '../../lib/fhir-converter/types.js';
import { runReconciliation, type ReconcilerInput } from '../../lib/reconciler.js';
import {
  DATA_TYPES,
  resolvePodDir,
  fileExists,
} from './helpers.js';
import {
  writePendingConflicts,
  generateConflictId,
  type PendingConflict,
} from '../../lib/user-resolutions.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Import report type
// ---------------------------------------------------------------------------

interface ImportReport {
  importedAt: string;
  podDir: string;
  sources: Array<{ file: string; system: string; resourceCount: number; warnings: string[] }>;
  reconciliation?: {
    enabled: boolean;
    crossBatch?: boolean;
    existingRecordsLoaded?: number;
    summary?: object;
  };
  filesWritten: Array<{ path: string; recordsAdded: number; type: string }>;
  typeCounts: Record<string, number>;
  totalRecordsImported: number;
  warnings: string[];
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Load existing pod data as ReconcilerInput records for cross-batch dedup
// ---------------------------------------------------------------------------

async function loadExistingPodData(podDir: string): Promise<ReconcilerInput[]> {
  // Pod data directories that contain reconcilable records
  const DATA_DIRS = ['clinical', 'wellness'];
  const inputs: ReconcilerInput[] = [];

  for (const dir of DATA_DIRS) {
    const dirPath = path.join(podDir, dir);
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue; // Directory doesn't exist yet
    }

    for (const file of files) {
      if (!file.endsWith('.ttl')) continue;
      const filePath = path.join(dirPath, file);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        if (content.trim().length > 0) {
          inputs.push({ content, systemName: 'existing-pod' });
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  return inputs;
}

// ---------------------------------------------------------------------------
// Turtle parsing helper: returns map from subject URI -> Quad[]
// ---------------------------------------------------------------------------

async function parseTurtleToQuads(turtle: string): Promise<Map<string, Quad[]>> {
  return new Promise((resolve, reject) => {
    const parser = new Parser({ format: 'Turtle' });
    const bySubject = new Map<string, Quad[]>();

    parser.parse(turtle, (error, quad) => {
      if (error) { reject(error); return; }
      if (!quad) { resolve(bySubject); return; }

      const subj = quad.subject.value;
      if (!bySubject.has(subj)) bySubject.set(subj, []);
      bySubject.get(subj)!.push(quad);
    });
  });
}

// ---------------------------------------------------------------------------
// Route a subject's rdf:type to a DATA_TYPES key
// ---------------------------------------------------------------------------

function routeTypeKey(quads: Quad[]): string {
  const rdfTypeIri = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const typeQuad = quads.find(q => q.predicate.value === rdfTypeIri);
  const typeIri = typeQuad?.object.value ?? '';

  // Exact match first
  for (const [key, info] of Object.entries(DATA_TYPES)) {
    if (info.isFhirPassthroughBucket) continue;
    if (info.rdfTypes.includes(typeIri)) return key;
  }

  // FHIR passthrough: type starts with http://hl7.org/fhir/
  if (typeIri.startsWith('http://hl7.org/fhir/')) return 'fhir-passthrough';

  // Unknown type: fallback to fhir-passthrough
  return 'fhir-passthrough';
}

// ---------------------------------------------------------------------------
// Shorten a full IRI to a prefixed form for type registrations
// ---------------------------------------------------------------------------

const PREFIX_MAP: Record<string, string> = {
  'https://ns.cascadeprotocol.org/core/v1#': 'cascade',
  'https://ns.cascadeprotocol.org/health/v1#': 'health',
  'https://ns.cascadeprotocol.org/clinical/v1#': 'clinical',
  'https://ns.cascadeprotocol.org/coverage/v1#': 'coverage',
  'http://hl7.org/fhir/': 'fhir',
};

function shortenForTurtle(iri: string): string {
  for (const [ns, prefix] of Object.entries(PREFIX_MAP)) {
    if (iri.startsWith(ns)) return `${prefix}:${iri.slice(ns.length)}`;
  }
  return `<${iri}>`;
}

// ---------------------------------------------------------------------------
// Build a TypeRegistration block
// ---------------------------------------------------------------------------

function buildTypeRegistration(key: string, info: typeof DATA_TYPES[string]): string {
  const forClass = shortenForTurtle(info.rdfTypes[0]);
  const instance = `</${info.directory}/${info.filename}>`;
  return `\n<#${key}> a solid:TypeRegistration ;\n    solid:forClass ${forClass} ;\n    solid:instance ${instance} .\n`;
}

// ---------------------------------------------------------------------------
// Determine which type index a DATA_TYPE entry should register in
// ---------------------------------------------------------------------------

function typeIndexForInfo(info: typeof DATA_TYPES[string]): 'publicTypeIndex.ttl' | 'privateTypeIndex.ttl' {
  return info.directory === 'clinical' ? 'publicTypeIndex.ttl' : 'privateTypeIndex.ttl';
}

// ---------------------------------------------------------------------------
// Append to type index file (string manipulation to preserve comments)
// ---------------------------------------------------------------------------

async function appendTypeRegistration(
  indexPath: string,
  key: string,
  info: typeof DATA_TYPES[string],
  dryRun: boolean,
): Promise<boolean> {
  const content = await fs.readFile(indexPath, 'utf-8');

  // Check if already registered (by key name)
  if (content.includes(`<#${key}>`) || content.includes(`/${info.filename}`)) {
    return false; // already present
  }

  const block = buildTypeRegistration(key, info);
  if (!dryRun) {
    await fs.appendFile(indexPath, block, 'utf-8');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Append ldp:contains reference to index.ttl
// ---------------------------------------------------------------------------

async function appendIndexContains(
  indexPath: string,
  relPath: string,
  dryRun: boolean,
): Promise<boolean> {
  const content = await fs.readFile(indexPath, 'utf-8');

  if (content.includes(relPath)) {
    return false; // already present
  }

  // Append a simple ldp:contains statement
  const line = `\n<> <http://www.w3.org/ns/ldp#contains> <${relPath}> .\n`;
  if (!dryRun) {
    await fs.appendFile(indexPath, line, 'utf-8');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerImportSubcommand(pod: Command, program: Command): void {
  pod
    .command('import')
    .description('Import FHIR JSON or Cascade Turtle files into a pod')
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    .argument('<files...>', 'FHIR JSON or Cascade Turtle files to import')
    .option('--source-system <name>', 'Tag all imported records with this system name')
    .option('--no-reconcile', 'Skip reconciliation even when importing multiple files')
    .option('--reconcile-existing', 'Include existing pod records in reconciliation pass (cross-batch dedup, on by default; disable with --no-reconcile-existing)', true)
    .option('--no-reconcile-existing', 'Skip loading existing pod records (additive import only)')
    .option('--trust <scores>', 'Trust scores e.g. hospital=0.95,clinic=0.85')
    .option('--dry-run', 'Preview the import without writing any files')
    .option('--report <file>', 'Write import report JSON to this file')
    .option('--passthrough <mode>', 'Passthrough mode: full or minimal (default: full)', 'full')
    .action(async (
      podDirArg: string,
      files: string[],
      options: {
        sourceSystem?: string;
        reconcile: boolean;
        reconcileExisting?: boolean;
        trust?: string;
        dryRun?: boolean;
        report?: string;
        passthrough: string;
      },
    ) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(podDirArg);
      const dryRun = options.dryRun ?? false;
      const passthroughMinimal = options.passthrough === 'minimal';

      // --- Step 1: Validate pod dir ---
      const indexTtlPath = path.join(podDir, 'index.ttl');
      if (!(await fileExists(indexTtlPath))) {
        printError(`Pod not found at ${podDir} (no index.ttl). Run 'cascade pod init' first.`, globalOpts);
        process.exitCode = 1;
        return;
      }

      if (dryRun) {
        printVerbose('Dry-run mode: no files will be written.', globalOpts);
      }

      // Parse trust scores
      const trustScores: Record<string, number> = {};
      if (options.trust) {
        for (const pair of options.trust.split(',')) {
          const [sys, score] = pair.split('=');
          if (sys && score) trustScores[sys] = parseFloat(score);
        }
      }

      // --- Step 2: Convert / collect inputs ---
      const reconcilerInputs: ReconcilerInput[] = [];
      const sourceReport: ImportReport['sources'] = [];
      const allWarnings: string[] = [];

      for (const filePath of files) {
        const absPath = path.resolve(process.cwd(), filePath);
        const isZip = absPath.toLowerCase().endsWith('.zip') || absPath.toLowerCase().endsWith('.xml');
        let rawContent: string | Buffer;
        try {
          rawContent = isZip ? await fs.readFile(absPath) : await fs.readFile(absPath, 'utf-8');
        } catch {
          printError(`Cannot read file: ${absPath}`, globalOpts);
          process.exitCode = 1;
          return;
        }

        const systemName = options.sourceSystem ?? path.basename(filePath, path.extname(filePath));
        const warnings: string[] = [];

        let turtleContent: string;
        let resourceCount = 0;

        // Detect C-CDA ZIP/XML vs FHIR JSON vs Turtle
        if (Buffer.isBuffer(rawContent)) {
          // C-CDA ZIP or XML — convert natively
          printVerbose(`Converting C-CDA: ${filePath}`, globalOpts);
          const result = await convert(rawContent, 'c-cda', 'cascade', 'turtle', systemName, passthroughMinimal);
          if (!result.success) {
            printError(`Failed to convert ${filePath}: ${result.errors.join(', ')}`, globalOpts);
            process.exitCode = 1;
            return;
          }
          turtleContent = result.output;
          resourceCount = result.resourceCount;
          warnings.push(...result.warnings);
          allWarnings.push(...result.warnings.map(w => `${filePath}: ${w}`));
        } else {
          const content = rawContent;
          const trimmed = content.trim();
        // Detect FHIR JSON vs Turtle
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          // FHIR JSON
          printVerbose(`Converting FHIR JSON: ${filePath}`, globalOpts);
          const result = await convert(content, 'fhir', 'cascade', 'turtle', systemName, passthroughMinimal);
          if (!result.success) {
            printError(`Failed to convert ${filePath}: ${result.errors.join(', ')}`, globalOpts);
            process.exitCode = 1;
            return;
          }
          turtleContent = result.output;
          resourceCount = result.resourceCount;
          warnings.push(...result.warnings);
          allWarnings.push(...result.warnings.map(w => `${filePath}: ${w}`));
        } else {
          // Assume Turtle
          printVerbose(`Reading Turtle: ${filePath}`, globalOpts);
          turtleContent = content;
          // Count subjects as rough resource count
          try {
            const quadsMap = await parseTurtleToQuads(turtleContent);
            resourceCount = quadsMap.size;
          } catch {
            resourceCount = 0;
          }
        }
        } // end non-ZIP branch

        reconcilerInputs.push({ content: turtleContent, systemName });
        sourceReport.push({ file: filePath, system: systemName, resourceCount, warnings });
      }

      // --- Step 3: Reconcile or concatenate ---
      let mergedTurtle: string;
      let reconciliationSummary: object | undefined;

      // Load existing pod data as an implicit source 0 when --reconcile-existing is set
      let existingInputs: ReconcilerInput[] = [];
      if (options.reconcileExisting !== false) {
        existingInputs = await loadExistingPodData(podDir);
        if (existingInputs.length > 0) {
          printVerbose(`Loaded ${existingInputs.length} existing pod file(s) for cross-batch reconciliation.`, globalOpts);
        }
      }

      const allInputs = [...existingInputs, ...reconcilerInputs];
      const shouldReconcile = options.reconcile !== false && allInputs.length > 1;

      if (shouldReconcile) {
        printVerbose(`Reconciling ${allInputs.length} inputs (${existingInputs.length} existing + ${reconcilerInputs.length} new)...`, globalOpts);
        const reconcileResult = await runReconciliation(allInputs, {
          trustScores,
          labTolerance: 0.05,
        });
        mergedTurtle = reconcileResult.turtle;
        reconciliationSummary = reconcileResult.report.summary;
        printVerbose(`Reconciliation complete. Final records: ${reconcileResult.report.summary.finalRecordCount}`, globalOpts);

        // Persist unresolved conflicts to settings/pending-conflicts.ttl
        if (!dryRun) {
          const pendingConflicts: PendingConflict[] = (reconcileResult.report.unresolvedConflicts as Array<{
            recordType: string;
            matchedOn: string;
            sources?: string[];
            candidateUris?: string[];
          }>).map((c) => ({
            uri: `urn:uuid:conflict-${randomUUID()}`,
            conflictId: generateConflictId(c.recordType, c.matchedOn),
            recordType: c.recordType,
            detectedAt: new Date(),
            candidateRecordUris: c.candidateUris ?? [],
            sourceA: c.sources?.[0],
            sourceB: c.sources?.[1],
          }));
          await writePendingConflicts(podDir, pendingConflicts);
          if (pendingConflicts.length > 0) {
            printVerbose(`  ${pendingConflicts.length} unresolved conflict(s) written to settings/pending-conflicts.ttl`, globalOpts);
          }
        }
      } else {
        mergedTurtle = allInputs.map(i => i.content).join('\n\n');
      }

      // When cross-batch reconciliation ran, the output already represents the
      // complete merged state — use replace mode in the write step below.
      const useCrossBatchReplace = existingInputs.length > 0 && shouldReconcile;

      // --- Step 4: Parse merged Turtle into quads grouped by subject ---
      let subjectQuads: Map<string, Quad[]>;
      try {
        subjectQuads = await parseTurtleToQuads(mergedTurtle);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        printError(`Failed to parse merged Turtle: ${msg}`, globalOpts);
        process.exitCode = 1;
        return;
      }

      // --- Step 5: Route subjects to DATA_TYPES buckets ---
      const buckets = new Map<string, Quad[][]>(); // key -> list of subject quad arrays
      for (const [, quads] of subjectQuads) {
        const key = routeTypeKey(quads);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(quads);
      }

      // --- Step 6 & 7: For each bucket, serialize and merge into pod files ---
      const filesWritten: ImportReport['filesWritten'] = [];
      const typeCounts: Record<string, number> = {};
      const newFiles: string[] = []; // relative paths (for index.ttl updates)

      for (const [typeKey, subjectQArrays] of buckets) {
        const info = DATA_TYPES[typeKey];
        if (!info) {
          allWarnings.push(`Unknown type key: ${typeKey} — skipping`);
          continue;
        }

        const targetFile = path.join(podDir, info.directory, info.filename);
        const relPath = `${info.directory}/${info.filename}`;

        // Serialize new quads
        const allNewQuads = subjectQArrays.flat();
        const newTurtle = await quadsToTurtle(allNewQuads);

        let finalTurtle: string;
        let recordsAdded = subjectQArrays.length;
        let isNewFile = true;

        if (useCrossBatchReplace) {
          // Cross-batch reconciliation: the reconciler output already represents
          // the complete merged state (existing + new, deduped). Write it directly
          // without re-merging against the existing file to avoid duplicates.
          isNewFile = !(await fileExists(targetFile));
          finalTurtle = newTurtle;
          // recordsAdded reflects the full set of subjects in this bucket after reconciliation
          recordsAdded = subjectQArrays.length;
        } else if (await fileExists(targetFile)) {
          isNewFile = false;
          // Merge: parse existing, combine unique subjects
          let existingQuads: Map<string, Quad[]>;
          try {
            const existing = await fs.readFile(targetFile, 'utf-8');
            existingQuads = await parseTurtleToQuads(existing);
          } catch {
            existingQuads = new Map();
          }

          // Add new subjects (dedup by subject URI)
          let addedCount = 0;
          for (const [subjectUri, quads] of subjectQuads) {
            if (routeTypeKey(quads) === typeKey && !existingQuads.has(subjectUri)) {
              existingQuads.set(subjectUri, quads);
              addedCount++;
            }
          }
          recordsAdded = addedCount;

          const mergedQuads = Array.from(existingQuads.values()).flat();
          finalTurtle = await quadsToTurtle(mergedQuads);
        } else {
          finalTurtle = newTurtle;
        }

        if (!dryRun) {
          await fs.mkdir(path.dirname(targetFile), { recursive: true });
          await fs.writeFile(targetFile, finalTurtle, 'utf-8');
        }

        typeCounts[typeKey] = (typeCounts[typeKey] ?? 0) + recordsAdded;
        filesWritten.push({ path: targetFile, recordsAdded, type: typeKey });

        if (isNewFile) {
          newFiles.push(relPath);
        }

        printVerbose(`  ${dryRun ? '[dry-run] ' : ''}${isNewFile ? 'Created' : 'Updated'} ${relPath} (+${recordsAdded} records)`, globalOpts);
      }

      // --- Step 8: Update type indexes ---
      const settingsDir = path.join(podDir, 'settings');
      const publicIndexPath = path.join(settingsDir, 'publicTypeIndex.ttl');
      const privateIndexPath = path.join(settingsDir, 'privateTypeIndex.ttl');

      for (const [typeKey] of buckets) {
        const info = DATA_TYPES[typeKey];
        if (!info) continue;

        const indexFile = typeIndexForInfo(info);
        const indexPath = indexFile === 'publicTypeIndex.ttl' ? publicIndexPath : privateIndexPath;

        if (await fileExists(indexPath)) {
          const appended = await appendTypeRegistration(indexPath, typeKey, info, dryRun);
          if (appended) {
            printVerbose(`  ${dryRun ? '[dry-run] ' : ''}Added type registration for ${typeKey} to ${indexFile}`, globalOpts);
          }
        }
      }

      // --- Step 9: Update index.ttl for new files ---
      for (const relPath of newFiles) {
        if (await fileExists(indexTtlPath)) {
          const appended = await appendIndexContains(indexTtlPath, relPath, dryRun);
          if (appended) {
            printVerbose(`  ${dryRun ? '[dry-run] ' : ''}Added ${relPath} to index.ttl`, globalOpts);
          }
        }
      }

      // --- Step 9b: Populate card.ttl (name only) and profile/extended.ttl (PHI) ---
      const cardPath = path.join(podDir, 'profile', 'card.ttl');
      const extendedPath = path.join(podDir, 'profile', 'extended.ttl');
      if (!dryRun && await fileExists(cardPath)) {
        const profileFile = path.join(podDir, 'clinical', 'patient-profile.ttl');
        if (await fileExists(profileFile)) {
          try {
            const profileTurtle = await fs.readFile(profileFile, 'utf-8');
            const profileQuads = await parseTurtleToQuads(profileTurtle);
            // Find the PatientProfile subject
            const NS_CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';
            const NS_VCARD = 'http://www.w3.org/2006/vcard/ns#';
            let patientSubjectQuads: Quad[] | undefined;
            for (const [, quads] of profileQuads) {
              if (quads.some(q =>
                q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
                q.object.value === `${NS_CASCADE}PatientProfile`)) {
                patientSubjectQuads = quads;
                break;
              }
            }
            if (patientSubjectQuads) {
              const getCascade = (pred: string) =>
                patientSubjectQuads!.find(q => q.predicate.value === `${NS_CASCADE}${pred}`)?.object.value ?? '';
              const getVcard = (pred: string) =>
                patientSubjectQuads!.find(q => q.predicate.value === `${NS_VCARD}${pred}`)?.object.value ?? '';

              const givenName = getCascade('givenName');
              const familyName = getCascade('familyName');
              const dob = getCascade('dateOfBirth');
              const sex = getCascade('biologicalSex');
              const phone = getVcard('hasTelephone');
              const email = getVcard('hasEmail');

              // Flat address predicates (stored directly on the patient subject)
              const street = getCascade('addressLine');
              const city = getCascade('addressCity');
              const state = getCascade('addressState');
              const postalCode = getCascade('addressPostalCode');

              const fullName = [givenName, familyName].filter(Boolean).join(' ');

              // ── card.ttl: public-safe name fields only ──
              if (fullName || givenName || familyName) {
                const cardTurtle = await fs.readFile(cardPath, 'utf-8');
                const nameFields: string[] = [];
                if (fullName) nameFields.push(`    foaf:name "${fullName}" ;`);
                if (givenName) nameFields.push(`    foaf:givenName "${givenName}" ;`);
                if (familyName) nameFields.push(`    foaf:familyName "${familyName}" ;`);
                // Replace the commented-out identity block
                const updated = cardTurtle.replace(
                  /    # ── Identity \(safe to make public\) ──\n(    #[^\n]*\n)*/,
                  `    # ── Identity (safe to make public) ──\n${nameFields.join('\n')}\n`,
                );
                await fs.writeFile(cardPath, updated, 'utf-8');
                printVerbose('  Populated profile/card.ttl with name from PatientProfile', globalOpts);
              }

              // ── extended.ttl: PHI (DOB, sex, address, phone, email) ──
              const hasPhiData = dob || sex || phone || email || street;
              if (hasPhiData && await fileExists(extendedPath)) {
                const phiFields: string[] = [];
                if (dob) phiFields.push(`    cascade:dateOfBirth "${dob}"^^xsd:date ;`);
                if (sex) phiFields.push(`    cascade:biologicalSex "${sex}" ;`);
                if (phone) phiFields.push(`    vcard:hasTelephone "${phone}" ;`);
                if (email) phiFields.push(`    vcard:hasEmail "${email}" ;`);
                if (street || city || state || postalCode) {
                  const addrLines: string[] = [];
                  if (street) addrLines.push(`        cascade:addressLine "${street}" ;`);
                  if (city) addrLines.push(`        cascade:addressCity "${city}" ;`);
                  if (state) addrLines.push(`        cascade:addressState "${state}" ;`);
                  if (postalCode) addrLines.push(`        cascade:addressPostalCode "${postalCode}" ;`);
                  phiFields.push(`    cascade:address [\n${addrLines.join('\n')}\n    ] ;`);
                }

                const extTurtle = await fs.readFile(extendedPath, 'utf-8');
                // Replace the commented-out PHI block (from # ── Demographics to the trailing dot)
                const updated = extTurtle.replace(
                  /    # ── Demographics ──\n[\s\S]*?\n    \./,
                  `    # ── Demographics ──\n${phiFields.join('\n')}\n    .`,
                );
                await fs.writeFile(extendedPath, updated, 'utf-8');
                printVerbose('  Populated profile/extended.ttl with PHI from PatientProfile', globalOpts);
              }
            }
          } catch {
            // Non-fatal: profile population is best-effort
          }
        }
      }

      // --- Step 10: Summary and report ---
      const totalRecordsImported = Object.values(typeCounts).reduce((a, b) => a + b, 0);

      const importReport: ImportReport = {
        importedAt: new Date().toISOString(),
        podDir,
        sources: sourceReport,
        reconciliation: shouldReconcile
          ? {
              enabled: true,
              crossBatch: existingInputs.length > 0,
              existingRecordsLoaded: existingInputs.length,
              summary: reconciliationSummary,
            }
          : { enabled: false },
        filesWritten,
        typeCounts,
        totalRecordsImported,
        warnings: allWarnings,
        dryRun,
      };

      if (options.report && !dryRun) {
        await fs.writeFile(options.report, JSON.stringify(importReport, null, 2), 'utf-8');
        printVerbose(`Import report written to: ${options.report}`, globalOpts);
      }

      if (globalOpts.json) {
        printResult(importReport, globalOpts);
      } else {
        if (dryRun) {
          console.log(`\n[dry-run] Import preview for pod: ${podDir}`);
        } else {
          console.log(`\nImport complete: ${podDir}`);
        }
        console.log(`  Sources:          ${sourceReport.length} file(s)`);
        console.log(`  Records imported: ${totalRecordsImported}`);
        console.log(`  Files written:    ${filesWritten.length}`);
        if (allWarnings.length > 0) {
          console.log(`  Warnings:         ${allWarnings.length}`);
          for (const w of allWarnings) {
            console.log(`    - ${w}`);
          }
        }
        for (const [type, count] of Object.entries(typeCounts)) {
          if (count > 0) console.log(`  ${type}: +${count}`);
        }
      }
    });
}
