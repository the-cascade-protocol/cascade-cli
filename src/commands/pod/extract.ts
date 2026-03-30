/**
 * cascade pod extract <pod-dir>
 *
 * Sends narrative text blocks from an imported C-CDA pod to the
 * cascade-agent extraction service (POST /extract) and writes
 * AI-extracted entities back to the pod.
 *
 * Requires: cascade agent serve (running on localhost:8765)
 *
 * Flow:
 *   1. Read clinical/documents.ttl — find ClinicalDocument nodes where
 *      cascade:requiresLLMExtraction = "true"
 *   2. Check cascade-agent is reachable at localhost:8765/health
 *   3. POST each narrative block to /extract
 *   4. Route results by confidence:
 *        >= 0.85 → auto-accepted → pod/clinical/ai-extracted.ttl
 *        0.50-0.84 → needs review → pod/analysis/review-queue.json
 *        < 0.50  → discarded → pod/analysis/discarded-extractions.ttl
 *   5. Print summary; remind user to run `cascade agent review` if needed
 */

import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseTurtleFile, getProperties, CASCADE_NAMESPACES } from '../../lib/turtle-parser.js';
import { resolvePodDir, fileExists } from './helpers.js';

// ── LOINC section code → CDA section string (used by /extract API) ───────────

const LOINC_TO_SECTION: Record<string, string> = {
  '10160-0': 'medications',
  '11450-4': 'conditions',
  '30954-2': 'labResults',
  '48765-2': 'allergies',
  '11369-6': 'immunizations',
  '8716-3':  'vitalSigns',
  '29762-2': 'socialHistory',
  '47519-4': 'procedures',
  '46240-8': 'procedures',   // encounters → map to procedures as fallback
  '10157-6': 'conditions',   // family history → conditions
  '46264-8': 'procedures',   // devices → procedures
};

// ── Module-level types ────────────────────────────────────────────────────────

interface NarrativeBlock {
  subjectUri: string;
  sectionCode: string;
  section: string;
  narrativeText: string;
}

// ── Types matching cascade-agent's /extract response ─────────────────────────

interface ExtractedEntity {
  type: string;
  displayName: string;
  confidence: number;
  sourceText: string;
  status?: string;
  normalizedCode?: string;
}

interface ExtractionResult {
  entities: ExtractedEntity[];
  confidence: number;
  modelId: string;
  latencyMs: number;
  requiresReview: boolean;
  schemaVersion: string;
}

interface ReviewQueueItem {
  id: string;
  section: string;
  narrativeText: string;
  result: ExtractionResult;
  status: 'pending';
  extractedAt: string;
}

// ── Command ───────────────────────────────────────────────────────────────────

export function registerExtractSubcommand(pod: Command): void {
  pod
    .command('extract <pod-dir>')
    .description('Send narrative text from imported C-CDA records to cascade-agent for AI extraction')
    .option('--agent-url <url>', 'cascade-agent base URL', 'http://127.0.0.1:8765')
    .option('--dry-run', 'Show what would be extracted without calling the agent')
    .option('--section <section>', 'Only extract a specific section (medications|conditions|labResults|...)')
    .action(async (
      podDirArg: string,
      opts: { agentUrl: string; dryRun?: boolean; section?: string },
      cmd: Command,
    ) => {
      const globalOpts = cmd.parent?.parent?.opts() as { json?: boolean; verbose?: boolean } ?? {};
      const podDir = resolvePodDir(podDirArg);

      // ── 1. Find narrative blocks in documents.ttl ─────────────────────────

      const documentsPath = path.join(podDir, 'clinical', 'documents.ttl');
      if (!(await fileExists(documentsPath))) {
        console.error('No clinical/documents.ttl found in pod. Import a C-CDA document first.');
        console.error(`  cascade pod import ${podDirArg} <file.xml>`);
        process.exitCode = 1;
        return;
      }

      const parsed = await parseTurtleFile(documentsPath);
      if (!parsed.success) {
        console.error(`Failed to parse clinical/documents.ttl: ${parsed.errors.join(', ')}`);
        process.exitCode = 1;
        return;
      }

      const NS_CASCADE    = CASCADE_NAMESPACES.cascade;
      const NS_CLINICAL   = CASCADE_NAMESPACES.clinical;
      const PRED_REQUIRES = NS_CASCADE + 'requiresLLMExtraction';
      const PRED_NARRATIVE = NS_CASCADE + 'narrativeText';
      const PRED_SECTION  = NS_CASCADE + 'sectionCode';
      const TYPE_DOC      = NS_CLINICAL + 'ClinicalDocument';

      const blocks: NarrativeBlock[] = [];

      for (const subject of parsed.subjects) {
        if (!subject.types.includes(TYPE_DOC)) continue;
        const props = getProperties(parsed.store, subject.uri);

        const requiresLLM = props[PRED_REQUIRES]?.[0];
        const narrativeText = props[PRED_NARRATIVE]?.[0];
        const sectionCode = props[PRED_SECTION]?.[0] ?? '';

        // Include blocks that either flag requiresLLMExtraction OR have narrative text
        if (!narrativeText?.trim() && requiresLLM !== 'true') continue;
        if (!narrativeText?.trim()) continue;

        const section = LOINC_TO_SECTION[sectionCode] ?? 'conditions';

        if (opts.section && opts.section !== section) continue;

        blocks.push({ subjectUri: subject.uri, sectionCode, section, narrativeText });
      }

      if (blocks.length === 0) {
        console.log('No narrative blocks found requiring extraction.');
        console.log('  (Blocks are written during `cascade pod import` from C-CDA files)');
        return;
      }

      // ── 2. Check / dry-run ────────────────────────────────────────────────

      if (opts.dryRun) {
        console.log(`\nDry run — ${blocks.length} narrative block(s) found:\n`);
        for (const b of blocks) {
          const preview = b.narrativeText.slice(0, 80).replace(/\n/g, ' ');
          console.log(`  [${b.section}]  ${preview}${b.narrativeText.length > 80 ? '…' : ''}`);
        }
        console.log(`\nRun without --dry-run to extract (requires: cascade agent serve)`);
        return;
      }

      // ── 3. Check agent health ─────────────────────────────────────────────

      const agentUrl = opts.agentUrl.replace(/\/$/, '');
      try {
        const health = await fetch(`${agentUrl}/health`, { signal: AbortSignal.timeout(3000) });
        if (!health.ok) throw new Error(`HTTP ${health.status}`);
        const body = await health.json() as { modelAvailable?: boolean; modelId?: string };
        if (!body.modelAvailable) {
          console.error('cascade-agent is running but no extraction model is loaded.');
          console.error('  Restart with: cascade agent serve   (will prompt to download the model)');
          process.exitCode = 1;
          return;
        }
        if (globalOpts.verbose) {
          console.error(`[extract] Agent: ${agentUrl}  model: ${body.modelId}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`cascade-agent is not reachable at ${agentUrl}/health: ${msg}`);
        console.error('  Start it with: cascade agent serve');
        process.exitCode = 1;
        return;
      }

      // ── 4. Extract each block ─────────────────────────────────────────────

      console.log(`\nExtracting ${blocks.length} narrative block(s) via ${agentUrl}…\n`);

      const autoAccepted: Array<{ block: NarrativeBlock; entity: ExtractedEntity; result: ExtractionResult }> = [];
      const needsReview:  ReviewQueueItem[] = [];
      let discardedCount = 0;
      let errorCount = 0;

      for (const block of blocks) {
        process.stdout.write(`  [${block.section}] `);
        try {
          const res = await fetch(`${agentUrl}/extract`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ section: block.section, narrativeText: block.narrativeText }),
            signal: AbortSignal.timeout(60_000),
          });
          if (!res.ok) {
            const err = await res.text();
            console.log(`error (HTTP ${res.status}: ${err.slice(0, 80)})`);
            errorCount++;
            continue;
          }
          const result = await res.json() as ExtractionResult;

          let accepted = 0, review = 0, discarded = 0;
          for (const entity of result.entities) {
            if (entity.confidence >= 0.85) {
              autoAccepted.push({ block, entity, result });
              accepted++;
            } else if (entity.confidence >= 0.50) {
              needsReview.push({
                id: `${block.section}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                section: block.section,
                narrativeText: block.narrativeText,
                result,
                status: 'pending',
                extractedAt: new Date().toISOString(),
              });
              review++;
              break; // one review item per block (contains all entities)
            } else {
              discarded++;
              discardedCount++;
            }
          }
          console.log(`${result.entities.length} entities  ✓${accepted} review${review} discard${discarded}  (${result.latencyMs}ms)`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`error: ${msg.slice(0, 60)}`);
          errorCount++;
        }
      }

      // ── 5. Write results to pod ───────────────────────────────────────────

      await fs.mkdir(path.join(podDir, 'clinical'), { recursive: true });
      await fs.mkdir(path.join(podDir, 'analysis'), { recursive: true });

      // 5a. Auto-accepted → clinical/ai-extracted.ttl
      if (autoAccepted.length > 0) {
        const extractedPath = path.join(podDir, 'clinical', 'ai-extracted.ttl');
        const existing = (await fileExists(extractedPath))
          ? await fs.readFile(extractedPath, 'utf-8')
          : '';
        const ttl = buildAIExtractedTurtle(autoAccepted, existing);
        await fs.writeFile(extractedPath, ttl, 'utf-8');
      }

      // 5b. Needs-review → analysis/review-queue.json (append)
      if (needsReview.length > 0) {
        const queuePath = path.join(podDir, 'analysis', 'review-queue.json');
        let existing: ReviewQueueItem[] = [];
        if (await fileExists(queuePath)) {
          try {
            existing = JSON.parse(await fs.readFile(queuePath, 'utf-8')) as ReviewQueueItem[];
          } catch { /* start fresh */ }
        }
        await fs.writeFile(
          queuePath,
          JSON.stringify([...existing, ...needsReview], null, 2),
          'utf-8',
        );
      }

      // 5c. Discarded → analysis/discarded-extractions.ttl (append header only)
      if (discardedCount > 0) {
        const discardPath = path.join(podDir, 'analysis', 'discarded-extractions.ttl');
        const note = `# ${discardedCount} entity/entities discarded (confidence < 0.50) on ${new Date().toISOString()}\n`;
        await fs.appendFile(discardPath, note, 'utf-8');
      }

      // ── 6. Summary ────────────────────────────────────────────────────────

      console.log('');
      console.log(`  ✓ Auto-accepted  ${autoAccepted.length} entities → clinical/ai-extracted.ttl`);
      if (needsReview.length > 0) {
        console.log(`  ⟳ Needs review   ${needsReview.length} block(s) → analysis/review-queue.json`);
      }
      if (discardedCount > 0) {
        console.log(`  ✗ Discarded      ${discardedCount} entities (confidence < 0.50)`);
      }
      if (errorCount > 0) {
        console.log(`  ! Errors         ${errorCount} block(s) failed`);
      }

      if (needsReview.length > 0) {
        console.log('');
        console.log('  Review low-confidence extractions:');
        console.log('    cascade agent review ' + podDirArg);
      }

      console.log('');
    });
}

// ── Turtle generation ─────────────────────────────────────────────────────────

function buildAIExtractedTurtle(
  accepted: Array<{ block: NarrativeBlock; entity: ExtractedEntity; result: ExtractionResult }>,
  existingContent: string,
): string {
  const header = existingContent.trim()
    ? existingContent.trim() + '\n\n'
    : `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
# AI-extracted clinical entities — auto-accepted (confidence >= 0.85)
# Review with: cascade agent review

`;

  const lines: string[] = [header];
  const now = new Date().toISOString();

  for (const { block, entity, result } of accepted) {
    const id = `urn:cascade:ai-extracted:${block.section}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const activityId = `${id}-activity`;

    // Entity record
    lines.push(`<${id}> a cascade:AIExtractionActivity ;`);
    lines.push(`    cascade:entityType "${entity.type}" ;`);
    lines.push(`    cascade:displayName "${escapeString(entity.displayName)}" ;`);
    lines.push(`    cascade:extractionConfidence "${entity.confidence}"^^xsd:decimal ;`);
    lines.push(`    cascade:sourceText "${escapeString(entity.sourceText)}" ;`);
    if (entity.normalizedCode) {
      lines.push(`    cascade:normalizedCode "${escapeString(entity.normalizedCode)}" ;`);
    }
    if (entity.status) {
      lines.push(`    cascade:status "${escapeString(entity.status)}" ;`);
    }
    lines.push(`    cascade:extractionModel "${escapeString(result.modelId)}" ;`);
    lines.push(`    cascade:sourceNarrativeSection "${block.section}" ;`);
    lines.push(`    cascade:dataProvenance cascade:AIExtracted ;`);
    lines.push(`    prov:generatedAtTime "${now}"^^xsd:dateTime .\n`);

    void activityId; // available for future prov:wasGeneratedBy linking
  }

  return lines.join('\n');
}

function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}
