/**
 * cascade pod info <pod-dir>
 *
 * Show pod metadata and statistics, including patient profile,
 * data file summary, and provenance information.
 */

import type { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { printResult, printError, printVerbose, type OutputOptions } from '../../lib/output.js';
import {
  parseTurtleFile,
  getSubjectsByType,
  getProperties,
  shortenIRI,
} from '../../lib/turtle-parser.js';
import {
  DATA_TYPES,
  CASCADE_NAMESPACES,
  resolvePodDir,
  isDirectory,
  fileExists,
  discoverTtlFiles,
  readPatientProfile,
  normalizeProvenanceLabel,
} from './helpers.js';

// ── Extraction pipeline status helper ─────────────────────────────────────────

async function getExtractionStatus(podDir: string): Promise<{
  narrativeBlocks: number;
  aiExtracted: number;
  pendingReview: number;
}> {
  let narrativeBlocks = 0;
  let aiExtracted = 0;
  let pendingReview = 0;

  // Count narrative blocks in documents.ttl
  const documentsPath = path.join(podDir, 'clinical', 'documents.ttl');
  if (await fileExists(documentsPath)) {
    try {
      const content = await fs.readFile(documentsPath, 'utf-8');
      narrativeBlocks = (content.match(/cascade:requiresLLMExtraction/g) ?? []).length;
    } catch { /* non-fatal */ }
  }

  // Count AI-extracted entities
  const aiExtractedPath = path.join(podDir, 'clinical', 'ai-extracted.ttl');
  if (await fileExists(aiExtractedPath)) {
    try {
      const result = await parseTurtleFile(aiExtractedPath);
      if (result.success) {
        // Count subjects that aren't AIExtractionActivity (those are provenance nodes)
        aiExtracted = result.subjects.filter(
          (s) => !s.types.some((t) => t.includes('AIExtractionActivity')),
        ).length;
      }
    } catch { /* non-fatal */ }
  }

  // Count pending review items
  const reviewPath = path.join(podDir, 'analysis', 'review-queue.json');
  if (await fileExists(reviewPath)) {
    try {
      const raw = await fs.readFile(reviewPath, 'utf-8');
      const items = JSON.parse(raw) as Array<{ status?: string }>;
      pendingReview = items.filter((i) => !i.status || i.status === 'pending').length;
    } catch { /* non-fatal */ }
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

      try {
        // Read patient profile info
        const profile = await readPatientProfile(absDir);

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

          const result = await parseTurtleFile(filePath);
          if (!result.success) continue;

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

        const extractionStatus = await getExtractionStatus(absDir);

        if (globalOpts.json) {
          printResult(
            {
              pod: podDir,
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
              console.log('\n  Next step: cascade pod extract ' + podDir);
            } else if (extractionStatus.pendingReview > 0) {
              console.log('\n  Next step: cascade agent review --pod ' + podDir);
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
