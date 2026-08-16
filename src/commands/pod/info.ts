/**
 * cascade pod info <pod-dir>
 *
 * Show pod metadata and statistics, including patient profile,
 * data file summary, and provenance information.
 *
 * Exit codes:
 *   0 — the pod was read and the summary below is of its actual contents
 *   1 — usage error (no such directory)
 *   2 — the pod, or a file inside it, could NOT be read
 *
 * The third one is the point. This command used to parse every data file as
 * PLAINTEXT and resolve a DEK for the owner's name only, non-interactively and
 * best-effort. On an encrypted pod that meant every parse failed silently, and
 * `pod info` printed "This pod has no data files yet" — with `"patient": {}`
 * and empty arrays at exit 0 in `--json` — over a pod holding hundreds of
 * records. An unreadable pod and an empty one must not share an answer.
 *
 * Two deliberate behavior changes come with that:
 *   - the passphrase now resolves the shared way (`CASCADE_POD_PASSPHRASE`, or
 *     a hidden prompt when interactive), the same as `pod query`, instead of
 *     env-only;
 *   - a pod that cannot be opened or read exits 2 and says which state it is
 *     in, rather than degrading to a summary of nothing.
 */

import type { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  printResult,
  printError,
  printErrorDetail,
  printVerbose,
  printWarning,
  type OutputOptions,
} from '../../lib/output.js';
import { getSubjectsByType, getProperties, shortenIRI } from '../../lib/turtle-parser.js';
import { shellCommand } from '../../lib/shell-quote.js';
import { DATA_TYPES, CASCADE_NAMESPACES, normalizeProvenanceLabel } from './helpers.js';
import {
  openPod,
  resolvePodDir,
  isDirectory,
  fileExists,
  discoverTtlFiles,
  unreadableFilesMessage,
  skippedFilesMessage,
  PodReadLedger,
  PodUnreadableError,
  type PodReader,
} from '../../lib/pod-read.js';

// ── Extraction pipeline status helper ─────────────────────────────────────────

/**
 * Count the extraction pipeline's three quantities.
 *
 * Every read goes through the reader, including `analysis/review-queue.json`:
 * that file is inside the encrypted set (only the manifest, the README and the
 * egress log are plaintext by design), so reading it with a plain `fs.readFile`
 * on a sealed pod yielded ciphertext, a swallowed JSON parse error, and a
 * silent zero.
 */
async function getExtractionStatus(reader: PodReader, ledger: PodReadLedger): Promise<{
  narrativeBlocks: number;
  aiExtracted: number;
  pendingReview: number;
}> {
  const podDir = reader.podDir;
  let narrativeBlocks = 0;
  let aiExtracted = 0;
  let pendingReview = 0;

  // Count narrative blocks in documents.ttl (a marker count, not a parse).
  const documentsPath = path.join(podDir, 'clinical', 'documents.ttl');
  if (await fileExists(documentsPath)) {
    ledger.attempt();
    const text = reader.readText(documentsPath);
    if (text.ok) {
      narrativeBlocks = (text.value.match(/cascade:requiresLLMExtraction/g) ?? []).length;
    } else {
      ledger.record(text.failure);
    }
  }

  // Count AI-extracted entities.
  const aiExtractedPath = path.join(podDir, 'clinical', 'ai-extracted.ttl');
  if (await fileExists(aiExtractedPath)) {
    ledger.attempt();
    const parsed = reader.parseFile(aiExtractedPath);
    if (parsed.ok) {
      // Subjects that aren't AIExtractionActivity (those are provenance nodes).
      aiExtracted = parsed.value.subjects.filter(
        (s) => !s.types.some((t) => t.includes('AIExtractionActivity')),
      ).length;
    } else {
      ledger.record(parsed.failure);
    }
  }

  // Count pending review items.
  const reviewPath = path.join(podDir, 'analysis', 'review-queue.json');
  if (await fileExists(reviewPath)) {
    ledger.attempt();
    const text = reader.readText(reviewPath);
    if (!text.ok) {
      ledger.record(text.failure);
    } else {
      try {
        const items = JSON.parse(text.value) as Array<{ status?: string }>;
        pendingReview = items.filter((i) => !i.status || i.status === 'pending').length;
      } catch {
        // Not Turtle and not this command's record picture: a malformed review
        // queue costs a count, not the whole summary.
        ledger.record({
          file: reader.relativePath(reviewPath),
          kind: 'parse',
          reason: 'review queue is not valid JSON',
        });
      }
    }
  }

  return { narrativeBlocks, aiExtracted, pendingReview };
}

export function registerInfoSubcommand(pod: Command, program: Command): void {
  pod
    .command('info')
    .description('Show pod metadata and statistics')
    .argument('<pod-dir>', 'Path to the Cascade Pod')
    .action(async (podDir: string) => {
      const globalOpts = program.opts() as OutputOptions;
      const absDir = resolvePodDir(podDir);

      printVerbose(`Getting info for pod: ${absDir}`, globalOpts);

      // Validate pod exists
      if (!(await isDirectory(absDir))) {
        printError(`Pod directory not found: ${absDir}`, globalOpts);
        process.exitCode = 1;
        return;
      }

      // Open the pod ONCE. A sealed pod this invocation cannot unlock stops
      // here: the alternative is the summary-of-nothing this command used to
      // print, which reads exactly like an empty pod.
      let reader: PodReader;
      try {
        reader = await openPod(absDir);
      } catch (err: unknown) {
        if (err instanceof PodUnreadableError) {
          printErrorDetail(
            err.message,
            { pod: podDir, encrypted: true, readable: false, reason: err.reason },
            globalOpts,
          );
        } else {
          printError(err instanceof Error ? err.message : String(err), globalOpts);
        }
        process.exitCode = 2;
        return;
      }

      try {
        const ledger = new PodReadLedger();

        // Read patient profile info.
        const { profile, failures: profileFailures } = await reader.readPatientProfile();
        for (const failure of profileFailures) {
          ledger.attempt();
          ledger.record(failure);
        }

        // Scan data files
        const clinicalSummary: Array<{ file: string; records: number; provenance: string; label: string }> = [];
        const wellnessSummary: Array<{ file: string; records: number; provenance: string; label: string }> = [];
        const provenanceSources = new Set<string>();

        // Get last modified time of the pod
        let lastModified: Date | undefined;
        const allTtlFiles = await discoverTtlFiles(absDir);

        for (const filePath of allTtlFiles) {
          const stat = await fs.stat(filePath);
          if (!lastModified || stat.mtime > lastModified) {
            lastModified = stat.mtime;
          }
        }

        // Analyze each known data type
        for (const [, typeInfo] of Object.entries(DATA_TYPES)) {
          const filePath = path.join(absDir, typeInfo.directory, typeInfo.filename);
          if (!(await fileExists(filePath))) continue;

          ledger.attempt();
          // A registered record file that will not read leaves its count
          // unknown. Reporting the file as absent (the old `continue`) is the
          // same lie in a quieter voice, so the ledger makes it fatal.
          const parsed = reader.parseFile(filePath);
          if (!parsed.ok) {
            ledger.record(parsed.failure);
            continue;
          }
          const result = parsed.value;

          // Count records by type
          let recordCount = 0;
          for (const rdfType of typeInfo.rdfTypes) {
            recordCount += getSubjectsByType(result.store, rdfType).length;
          }

          // If no records found by type, count all typed subjects
          if (recordCount === 0 && result.subjects.length > 0) {
            recordCount = result.subjects.length;
          }

          // Detect provenance
          const provenanceValues = new Set<string>();
          for (const subject of result.subjects) {
            const props = getProperties(result.store, subject.uri);
            const prov = props[CASCADE_NAMESPACES.cascade + 'dataProvenance'];
            if (prov) {
              for (const p of prov) {
                const shortProv = normalizeProvenanceLabel(shortenIRI(p));
                provenanceValues.add(shortProv);
                provenanceSources.add(shortProv);
              }
            }
          }

          // For wellness files, also check for prov:wasGeneratedBy / cascade:sourceType
          // which indicates DeviceGenerated provenance
          if (provenanceValues.size === 0) {
            const allQuads = result.quads;
            const hasDeviceSource = allQuads.some(
              (q) =>
                (q.predicate.value === CASCADE_NAMESPACES.cascade + 'sourceType' &&
                  (q.object.value === 'healthKit' || q.object.value === 'bluetoothDevice')) ||
                // Also detect device provenance from prov:wasGeneratedBy patterns
                (q.predicate.value === 'http://www.w3.org/ns/prov#wasGeneratedBy'),
            );
            // If in wellness directory and has device data patterns, infer DeviceGenerated
            if (hasDeviceSource || typeInfo.directory === 'wellness') {
              const hasDeviceTypes = allQuads.some(
                (q) =>
                  q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
                  (q.object.value.includes('HeartRateData') ||
                    q.object.value.includes('BloodPressureData') ||
                    q.object.value.includes('ActivityData') ||
                    q.object.value.includes('SleepData') ||
                    q.object.value.includes('DailyVitalReading') ||
                    q.object.value.includes('DailyActivitySnapshot') ||
                    q.object.value.includes('DailySleepSnapshot') ||
                    q.object.value === 'http://hl7.org/fhir/Observation'),
              );
              if (hasDeviceSource || hasDeviceTypes) {
                provenanceValues.add('cascade:DeviceGenerated');
                provenanceSources.add('cascade:DeviceGenerated');
              }
            }
          }

          const provenanceStr = provenanceValues.size > 0
            ? Array.from(provenanceValues).join(', ')
            : 'Unknown';

          // Determine record description
          let recordDesc: string;
          // For time-series data (vital signs, heart rate, etc.), show as "X days" if applicable
          const isTimeSeries = ['vital-signs', 'heart-rate', 'blood-pressure', 'activity', 'sleep'].some(
            (ts) => typeInfo.filename.includes(ts.replace('-', '-')),
          );
          if (isTimeSeries && recordCount >= 28) {
            recordDesc = `${recordCount} days`;
          } else if (recordCount === 1) {
            recordDesc = '1 record';
          } else {
            recordDesc = `${recordCount} records`;
          }

          const entry = {
            file: typeInfo.filename,
            records: recordCount,
            provenance: provenanceStr,
            label: `${typeInfo.filename.padEnd(22)} ${recordDesc.padEnd(16)} (${provenanceStr})`,
          };

          if (typeInfo.directory === 'clinical') {
            clinicalSummary.push(entry);
          } else {
            wellnessSummary.push(entry);
          }
        }

        const extractionStatus = await getExtractionStatus(reader, ledger);

        // Anything fatal means the numbers below are not the pod's numbers.
        // Print no summary at all rather than a partial one that reads whole.
        if (ledger.hasFatal) {
          printErrorDetail(
            unreadableFilesMessage(absDir, ledger.fatal, ledger.attempted),
            {
              pod: podDir,
              encrypted: reader.encrypted,
              readable: false,
              reason: 'files-unreadable',
              files: ledger.fatal.map((f) => f.file),
            },
            globalOpts,
          );
          process.exitCode = 2;
          return;
        }

        // Not fatal, never silent.
        if (ledger.skipped.length > 0) {
          printWarning(skippedFilesMessage(ledger.skipped), globalOpts);
        }

        if (globalOpts.json) {
          printResult(
            {
              pod: podDir,
              // Stated positively so a consumer can branch on the state instead
              // of inferring "it read fine" from the absence of an error.
              encrypted: reader.encrypted,
              readable: true,
              patient: {
                name: profile.name,
                age: profile.age,
                dateOfBirth: profile.dateOfBirth,
              },
              schemaVersion: profile.schemaVersion,
              lastModified: lastModified?.toISOString(),
              clinical: clinicalSummary.map((s) => ({
                file: s.file,
                records: s.records,
                provenance: s.provenance,
              })),
              wellness: wellnessSummary.map((s) => ({
                file: s.file,
                records: s.records,
                provenance: s.provenance,
              })),
              provenanceSources: Array.from(provenanceSources),
              extraction: extractionStatus,
            },
            globalOpts,
          );
        } else {
          // Human-readable output
          console.log(`\nCascade Pod: ${podDir}\n`);

          if (profile.name) {
            const ageStr = profile.age ? ` (age ${profile.age})` : '';
            console.log(`Patient: ${profile.name}${ageStr}`);
          }
          if (profile.schemaVersion) {
            console.log(`Schema Version: ${profile.schemaVersion}`);
          }
          if (lastModified) {
            console.log(`Last Modified: ${lastModified.toISOString().split('T')[0]}`);
          }

          if (clinicalSummary.length > 0) {
            console.log('\nData Summary:');
            console.log('  Clinical:');
            for (const entry of clinicalSummary) {
              console.log(`    ${entry.label}`);
            }
          }

          if (wellnessSummary.length > 0) {
            if (clinicalSummary.length === 0) {
              console.log('\nData Summary:');
            }
            console.log('  Wellness:');
            for (const entry of wellnessSummary) {
              console.log(`    ${entry.label}`);
            }
          }

          if (provenanceSources.size > 0) {
            console.log(`\nProvenance Sources: ${Array.from(provenanceSources).join(', ')}`);
          }

          // ── Extraction pipeline status ──────────────────────────────────
          if (extractionStatus.narrativeBlocks > 0 || extractionStatus.aiExtracted > 0) {
            console.log('\nAI Extraction:');
            if (extractionStatus.narrativeBlocks > 0) {
              console.log(`  Narrative blocks:   ${extractionStatus.narrativeBlocks} in clinical/documents.ttl`);
            }
            if (extractionStatus.aiExtracted > 0) {
              console.log(`  Auto-accepted:      ${extractionStatus.aiExtracted} entities in clinical/ai-extracted.ttl`);
            }
            if (extractionStatus.pendingReview > 0) {
              console.log(`  Pending review:     ${extractionStatus.pendingReview} item(s) in analysis/review-queue.json`);
            }
            if (extractionStatus.narrativeBlocks > 0 && extractionStatus.aiExtracted === 0) {
              console.log(`\n  Next step: ${shellCommand('cascade', 'pod', 'extract', podDir)}`);
            } else if (extractionStatus.pendingReview > 0) {
              console.log(`\n  Next step: ${shellCommand('cascade', 'agent', 'review', '--pod', podDir)}`);
            }
          }

          if (clinicalSummary.length === 0 && wellnessSummary.length === 0) {
            console.log('\nThis pod has no data files yet.');
            console.log('Add TTL files to the clinical/ or wellness/ directories to get started.');
          }

          console.log('');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        printError(`Failed to read pod info: ${message}`, globalOpts);
        process.exitCode = 1;
      }
    });
}
