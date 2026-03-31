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
 *        < 0.50  → discarded  → pod/analysis/discarded-extractions.ttl
 *   5. Update pod index.ttl for any new files written
 *   6. Print summary; remind user to run `cascade agent review` if needed
 */

import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
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
  '46240-8': 'encounters',    // encounters — not procedures
  '10157-6': 'familyHistory', // family history — not conditions
  '46264-8': 'devices',       // implanted devices — not procedures
};

// ── entity.type string → Cascade RDF class (prefixed) ────────────────────────
//
// Maps strings returned by /extract to the correct domain RDF type.
// All keys are lower-cased for case-insensitive lookup. Falls back to
// clinical:Condition (the most semantically neutral clinical class) for
// unknown types so the triple is always valid against the ontology.

const ENTITY_TYPE_MAP: Record<string, string> = {
  medication:    'clinical:Medication',
  condition:     'clinical:Condition',
  allergy:       'clinical:Allergy',
  labresult:     'clinical:LabResult',
  immunization:  'clinical:Immunization',
  vitalsign:     'clinical:VitalSign',
  procedure:     'clinical:Procedure',
  encounter:     'clinical:Encounter',
  device:        'clinical:ImplantedDevice',
  familyhistory: 'clinical:Condition',   // no FamilyHistory class; conditions are the closest
  supplement:    'clinical:Supplement',
};

function entityRdfType(typeString: string): string {
  return ENTITY_TYPE_MAP[typeString.toLowerCase()] ?? 'clinical:Condition';
}

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

interface ExtractionError {
  blockUri: string;
  section: string;
  charCount: number;
  errorType: 'context_overflow' | 'timeout' | 'server_error' | 'unknown';
  errorMessage: string;
  timestamp: string;
}

// ── Deterministic ID helpers ──────────────────────────────────────────────────
//
// URIs are derived by hashing stable inputs so that re-running `pod extract`
// on the same data produces the same identifiers. This enables safe
// deduplication and reconciliation.

function sha256Hex(...parts: string[]): string {
  const h = crypto.createHash('sha256');
  for (const p of parts) { h.update(p); h.update('\x00'); }
  return h.digest('hex').slice(0, 16);
}

function deterministicExtractionUri(section: string, displayName: string, sourceText: string): string {
  return `urn:cascade:ai-extracted:${section}-${sha256Hex(section, displayName, sourceText)}`;
}

function deterministicActivityUri(section: string, narrativeText: string, modelId: string): string {
  return `urn:cascade:ai-activity:${section}-${sha256Hex(section, narrativeText, modelId)}`;
}

function deterministicQueueId(section: string, narrativeText: string): string {
  return `${section}-${sha256Hex(section, narrativeText)}`;
}

// ── Pod index helper ──────────────────────────────────────────────────────────

async function appendIndexContains(indexPath: string, relPath: string): Promise<boolean> {
  const content = await fs.readFile(indexPath, 'utf-8');
  if (content.includes(relPath)) return false;
  await fs.appendFile(indexPath, `\n<> <http://www.w3.org/ns/ldp#contains> <${relPath}> .\n`, 'utf-8');
  return true;
}

// ── Chunking helpers ──────────────────────────────────────────────────────────

/**
 * Maximum input tokens for the extraction model context.
 * Qwen3.5-4B Q4_K_M has a 32K token context. Reserve ~4K for system prompt,
 * output, and template overhead → 28K usable for narrative input.
 * In chars: 28K * 4 = 112K, but the real bottleneck is tokenizer overhead on
 * tables/structured text, so use a conservative 24K char threshold.
 */
const MAX_BLOCK_CHARS = 24_000;

/**
 * Split a large narrative block along natural boundaries (double-newlines,
 * then single newlines, then mid-text) into chunks ≤ maxChars.
 */
function chunkNarrativeBlock(text: string, maxChars: number = MAX_BLOCK_CHARS): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    // Try to split on a double-newline (paragraph break)
    let splitIdx = remaining.lastIndexOf('\n\n', maxChars);
    // Fall back to single newline
    if (splitIdx < maxChars * 0.3) splitIdx = remaining.lastIndexOf('\n', maxChars);
    // Last resort: split mid-sentence at a space
    if (splitIdx < maxChars * 0.3) splitIdx = remaining.lastIndexOf(' ', maxChars);
    // Absolute last resort: hard split
    if (splitIdx < maxChars * 0.3) splitIdx = maxChars;

    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ── Idempotency helpers ──────────────────────────────────────────────────────

/**
 * Load fingerprints for blocks already extracted. Uses the deterministic
 * queue ID (section + narrative hash, model-independent) as the key.
 *
 * Sources:
 * - review-queue.json: item.id is exactly the queue ID
 * - ai-extracted.ttl: sourceNarrativeSection predicates paired with
 *   activity URIs tell us which sections were processed, but the activity
 *   hash includes modelId. Instead, we look at whether extractedEntities
 *   reference the same section; however the most reliable signal is the
 *   queue. For auto-accepted blocks (not in review queue), we store a
 *   separate extraction-done.json manifest.
 * - extraction-done.json: written after each successful extraction run
 */
async function loadCompletedBlockIds(podDir: string): Promise<Set<string>> {
  const ids = new Set<string>();

  // From review-queue.json
  const queuePath = path.join(podDir, 'analysis', 'review-queue.json');
  if (await fileExists(queuePath)) {
    try {
      const raw = await fs.readFile(queuePath, 'utf-8');
      const items = JSON.parse(raw) as Array<{ id: string }>;
      for (const item of items) ids.add(item.id);
    } catch { /* non-fatal */ }
  }

  // From extraction-done.json (written by this command after each run)
  const donePath = path.join(podDir, 'analysis', 'extraction-done.json');
  if (await fileExists(donePath)) {
    try {
      const raw = await fs.readFile(donePath, 'utf-8');
      const doneIds = JSON.parse(raw) as string[];
      for (const id of doneIds) ids.add(id);
    } catch { /* non-fatal */ }
  }

  return ids;
}

// ── Error classification ─────────────────────────────────────────────────────

function classifyExtractionError(errMsg: string, httpStatus?: number): ExtractionError['errorType'] {
  if (errMsg.includes('Eval has failed') || errMsg.includes('context')) return 'context_overflow';
  if (errMsg.includes('aborted') || errMsg.includes('timeout') || errMsg.includes('TimeoutError')) return 'timeout';
  if (httpStatus && httpStatus >= 500) return 'server_error';
  return 'unknown';
}

function humanReadableError(errorType: ExtractionError['errorType'], charCount: number): string {
  switch (errorType) {
    case 'context_overflow':
      return `block too large (${charCount.toLocaleString()} chars) — exceeded model context window`;
    case 'timeout':
      return `inference timed out (${charCount.toLocaleString()} chars) — block may be too large or model too slow`;
    case 'server_error':
      return `agent server error — check cascade agent serve logs`;
    default:
      return `unexpected error`;
  }
}

// ── Auto-spawn helpers ────────────────────────────────────────────────────────

/** Check ~/.config/cascade-agent/models/ for a downloaded GGUF model. */
function findLocalModel(): string | null {
  const modelsDir = path.join(os.homedir(), '.config', 'cascade-agent', 'models');
  try {
    const files = fsSync.readdirSync(modelsDir);
    return files.find((f) => f.endsWith('.gguf')) ?? null;
  } catch {
    return null;
  }
}

/**
 * Poll the agent's /health endpoint until modelAvailable is true or timeout.
 * Shows a dot every 3 seconds so the user knows something is happening.
 */
async function waitForAgent(agentUrl: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  let lastDot = start;
  while (Date.now() - start < timeoutMs) {
    await new Promise<void>((r) => setTimeout(r, 800));
    const now = Date.now();
    if (now - lastDot >= 3000) {
      process.stdout.write('.');
      lastDot = now;
    }
    try {
      const res = await fetch(`${agentUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) continue;
      const body = await res.json() as { modelAvailable?: boolean };
      if (body.modelAvailable) return true;
    } catch { /* not ready yet */ }
  }
  return false;
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
      let spawnedAgent: ChildProcess | null = null;

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
      const PRED_REQUIRES  = NS_CASCADE + 'requiresLLMExtraction';
      const PRED_NARRATIVE = NS_CASCADE + 'narrativeText';
      const PRED_SECTION   = NS_CASCADE + 'sectionCode';
      const TYPE_DOC       = NS_CLINICAL + 'ClinicalDocument';

      const blocks: NarrativeBlock[] = [];

      for (const subject of parsed.subjects) {
        if (!subject.types.includes(TYPE_DOC)) continue;
        const props = getProperties(parsed.store, subject.uri);

        const requiresLLM   = props[PRED_REQUIRES]?.[0];
        const narrativeText = props[PRED_NARRATIVE]?.[0];
        const sectionCode   = props[PRED_SECTION]?.[0] ?? '';

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

      // ── 2. Dry-run ────────────────────────────────────────────────────────

      if (opts.dryRun) {
        console.log(`\nDry run — ${blocks.length} narrative block(s) found:\n`);
        for (const b of blocks) {
          const preview = b.narrativeText.slice(0, 80).replace(/\n/g, ' ');
          console.log(`  [${b.section}]  ${preview}${b.narrativeText.length > 80 ? '…' : ''}`);
        }
        console.log(`\nRun without --dry-run to extract (requires: cascade agent serve)`);
        return;
      }

      // ── 3. Check agent health (auto-spawn if not running) ─────────────────

      const agentUrl = opts.agentUrl.replace(/\/$/, '');

      const checkAgent = async (): Promise<'ready' | 'no-model' | 'unreachable'> => {
        try {
          const res = await fetch(`${agentUrl}/health`, { signal: AbortSignal.timeout(3000) });
          if (!res.ok) return 'unreachable';
          const body = await res.json() as { modelAvailable?: boolean; modelId?: string };
          if (globalOpts.verbose) console.error(`[extract] Agent: ${agentUrl}  model: ${body.modelId}`);
          return body.modelAvailable ? 'ready' : 'no-model';
        } catch {
          return 'unreachable';
        }
      };

      let agentStatus = await checkAgent();

      if (agentStatus === 'no-model') {
        console.error('cascade-agent is running but no extraction model is loaded.');
        console.error('  Restart with: cascade agent serve   (will prompt to download the model)');
        process.exitCode = 1;
        return;
      }

      if (agentStatus === 'unreachable') {
        const modelFile = findLocalModel();
        if (!modelFile) {
          console.error(`cascade-agent is not reachable at ${agentUrl}.`);
          console.error('  No local extraction model found.');
          console.error('  Download one with: cascade agent login --provider local');
          process.exitCode = 1;
          return;
        }

        // Auto-spawn cascade agent serve
        const agentPort = new URL(agentUrl).port || '8765';
        console.log(`  cascade-agent not running — starting automatically (model: ${modelFile})`);
        spawnedAgent = spawn('cascade', ['agent', 'serve', '--port', agentPort], {
          stdio: 'ignore',
          detached: false,
        });
        spawnedAgent.on('error', () => { /* suppress spawn errors — handled by timeout below */ });

        process.stdout.write('  Loading model ');
        const ready = await waitForAgent(agentUrl, 120_000);
        console.log('');

        if (!ready) {
          spawnedAgent.kill();
          spawnedAgent = null;
          console.error('  Timed out waiting for cascade-agent to start (120s).');
          console.error('  Start it manually: cascade agent serve');
          process.exitCode = 1;
          return;
        }
        console.log('  cascade-agent ready\n');
        agentStatus = 'ready';
      }

      // ── 4. Check idempotency — skip already-extracted blocks ────────────

      const completedIds = await loadCompletedBlockIds(podDir);
      const pendingBlocks: NarrativeBlock[] = [];
      let skippedCount = 0;

      for (const block of blocks) {
        const blockId = deterministicQueueId(block.section, block.narrativeText);
        if (completedIds.has(blockId)) {
          skippedCount++;
          continue;
        }
        pendingBlocks.push(block);
      }

      if (skippedCount > 0) {
        console.log(`  Skipping ${skippedCount} already-extracted block(s)`);
      }

      if (pendingBlocks.length === 0) {
        console.log('\nAll narrative blocks have already been extracted.');
        console.log('  Re-import the C-CDA to generate new blocks, or delete');
        console.log('  clinical/ai-extracted.ttl and analysis/review-queue.json to re-extract.');
        return;
      }

      // ── 5. Extract each block (with chunking for oversized blocks) ───────

      console.log(`\nExtracting ${pendingBlocks.length} narrative block(s) via ${agentUrl}…\n`);

      const autoAccepted: Array<{ block: NarrativeBlock; entity: ExtractedEntity; result: ExtractionResult }> = [];
      const needsReview:  ReviewQueueItem[] = [];
      const discardedEntities: Array<{ block: NarrativeBlock; entity: ExtractedEntity }> = [];
      const extractionErrors: ExtractionError[] = [];
      const succeededBlockIds: string[] = [];
      let errorCount = 0;

      for (const block of pendingBlocks) {
        const chunks = chunkNarrativeBlock(block.narrativeText);
        const isChunked = chunks.length > 1;

        if (isChunked) {
          process.stdout.write(`  [${block.section}] (${block.narrativeText.length.toLocaleString()} chars → ${chunks.length} chunks) `);
        } else {
          process.stdout.write(`  [${block.section}] `);
        }

        // Scale timeout with block size: base 60s + 20ms per char, capped at 5 min
        const timeoutMs = Math.min(300_000, 60_000 + block.narrativeText.length * 20);

        let blockAccepted = 0, blockReview = 0, blockDiscarded = 0;
        let blockError = false;
        let totalLatencyMs = 0;
        let addedToReview = false;

        for (let ci = 0; ci < chunks.length; ci++) {
          const chunkText = chunks[ci];
          try {
            const res = await fetch(`${agentUrl}/extract`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ section: block.section, narrativeText: chunkText }),
              signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) {
              const errText = await res.text();
              const errorType = classifyExtractionError(errText, res.status);
              const readable = humanReadableError(errorType, chunkText.length);
              if (isChunked) {
                console.log(`\n    chunk ${ci + 1}/${chunks.length}: ${readable}`);
              } else {
                console.log(readable);
              }
              extractionErrors.push({
                blockUri: block.subjectUri,
                section: block.section,
                charCount: chunkText.length,
                errorType,
                errorMessage: errText.slice(0, 200),
                timestamp: new Date().toISOString(),
              });
              blockError = true;
              continue;
            }
            const result = await res.json() as ExtractionResult;
            totalLatencyMs += result.latencyMs;

            for (const entity of result.entities) {
              if (entity.confidence >= 0.85) {
                autoAccepted.push({ block, entity, result });
                blockAccepted++;
              } else if (entity.confidence >= 0.50) {
                if (!addedToReview) {
                  needsReview.push({
                    id: deterministicQueueId(block.section, block.narrativeText),
                    section: block.section,
                    narrativeText: block.narrativeText,
                    result,
                    status: 'pending',
                    extractedAt: new Date().toISOString(),
                  });
                  addedToReview = true;
                }
                blockReview++;
              } else {
                discardedEntities.push({ block, entity });
                blockDiscarded++;
              }
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const errorType = classifyExtractionError(msg);
            const readable = humanReadableError(errorType, chunkText.length);
            if (isChunked) {
              console.log(`\n    chunk ${ci + 1}/${chunks.length}: ${readable}`);
            } else {
              console.log(readable);
            }
            extractionErrors.push({
              blockUri: block.subjectUri,
              section: block.section,
              charCount: chunkText.length,
              errorType,
              errorMessage: msg.slice(0, 200),
              timestamp: new Date().toISOString(),
            });
            blockError = true;
          }
        }

        if (blockError && blockAccepted === 0 && blockReview === 0) {
          errorCount++;
        } else {
          succeededBlockIds.push(deterministicQueueId(block.section, block.narrativeText));
          const totalEntities = blockAccepted + blockReview + blockDiscarded;
          const chunkSuffix = isChunked ? ` [${chunks.length} chunks]` : '';
          console.log(`${totalEntities} entities  ✓${blockAccepted} review${blockReview} discard${blockDiscarded}  (${totalLatencyMs}ms)${chunkSuffix}`);
        }
      }

      // ── 6. Write results to pod ───────────────────────────────────────────

      await fs.mkdir(path.join(podDir, 'clinical'), { recursive: true });
      await fs.mkdir(path.join(podDir, 'analysis'), { recursive: true });

      const indexTtlPath = path.join(podDir, 'index.ttl');
      const newFiles: string[] = [];

      // 6a. Auto-accepted → clinical/ai-extracted.ttl
      if (autoAccepted.length > 0) {
        const extractedPath = path.join(podDir, 'clinical', 'ai-extracted.ttl');
        const isNew = !(await fileExists(extractedPath));
        const existing = isNew ? '' : await fs.readFile(extractedPath, 'utf-8');
        await fs.writeFile(extractedPath, buildAIExtractedTurtle(autoAccepted, existing), 'utf-8');
        if (isNew) newFiles.push('clinical/ai-extracted.ttl');
      }

      // 6b. Needs-review → analysis/review-queue.json (append, deduplicate by id)
      if (needsReview.length > 0) {
        const queuePath = path.join(podDir, 'analysis', 'review-queue.json');
        let existing: ReviewQueueItem[] = [];
        if (await fileExists(queuePath)) {
          try {
            existing = JSON.parse(await fs.readFile(queuePath, 'utf-8')) as ReviewQueueItem[];
          } catch { /* start fresh */ }
        }
        const existingIds = new Set(existing.map((item) => item.id));
        const toAdd = needsReview.filter((item) => !existingIds.has(item.id));
        if (toAdd.length > 0) {
          await fs.writeFile(
            queuePath,
            JSON.stringify([...existing, ...toAdd], null, 2),
            'utf-8',
          );
        }
      }

      // 6c. Discarded → analysis/discarded-extractions.ttl (actual RDF records)
      if (discardedEntities.length > 0) {
        const discardPath = path.join(podDir, 'analysis', 'discarded-extractions.ttl');
        const isNew = !(await fileExists(discardPath));
        const existing = isNew ? '' : await fs.readFile(discardPath, 'utf-8');
        await fs.appendFile(discardPath, buildDiscardedTurtle(discardedEntities, existing), 'utf-8');
        if (isNew) newFiles.push('analysis/discarded-extractions.ttl');
      }

      // 6d. Record successfully-processed block IDs for idempotency
      if (succeededBlockIds.length > 0) {
        const donePath = path.join(podDir, 'analysis', 'extraction-done.json');
        let existing: string[] = [];
        if (await fileExists(donePath)) {
          try { existing = JSON.parse(await fs.readFile(donePath, 'utf-8')) as string[]; } catch { /* fresh */ }
        }
        const existingSet = new Set(existing);
        const newIds = succeededBlockIds.filter((id) => !existingSet.has(id));
        if (newIds.length > 0) {
          await fs.writeFile(donePath, JSON.stringify([...existing, ...newIds], null, 2), 'utf-8');
        }
      }

      // 6e. Extraction errors → analysis/extraction-errors.json
      if (extractionErrors.length > 0) {
        const errorsPath = path.join(podDir, 'analysis', 'extraction-errors.json');
        let existing: ExtractionError[] = [];
        if (await fileExists(errorsPath)) {
          try {
            existing = JSON.parse(await fs.readFile(errorsPath, 'utf-8')) as ExtractionError[];
          } catch { /* start fresh */ }
        }
        // Deduplicate by blockUri + section
        const existingKeys = new Set(existing.map((e) => `${e.blockUri}:${e.section}`));
        const newErrors = extractionErrors.filter((e) => !existingKeys.has(`${e.blockUri}:${e.section}`));
        if (newErrors.length > 0) {
          await fs.writeFile(errorsPath, JSON.stringify([...existing, ...newErrors], null, 2), 'utf-8');
        }
      }

      // 6e. Update pod index.ttl for any new files written this run
      if (newFiles.length > 0 && await fileExists(indexTtlPath)) {
        for (const relPath of newFiles) {
          await appendIndexContains(indexTtlPath, relPath);
        }
      }

      // ── 7. Summary ────────────────────────────────────────────────────────

      console.log('');
      if (skippedCount > 0) {
        console.log(`  - Skipped        ${skippedCount} already-extracted block(s)`);
      }
      console.log(`  ✓ Auto-accepted  ${autoAccepted.length} entities → clinical/ai-extracted.ttl`);
      if (needsReview.length > 0) {
        console.log(`  ⟳ Needs review   ${needsReview.length} block(s) → analysis/review-queue.json`);
      }
      if (discardedEntities.length > 0) {
        console.log(`  ✗ Discarded      ${discardedEntities.length} entities (confidence < 0.50)`);
      }
      if (errorCount > 0) {
        console.log(`  ! Errors         ${errorCount} block(s) failed → analysis/extraction-errors.json`);
        // Summarize error types
        const byType = new Map<string, number>();
        for (const e of extractionErrors) byType.set(e.errorType, (byType.get(e.errorType) ?? 0) + 1);
        for (const [type, count] of byType) {
          console.log(`                   ${count}x ${type.replace('_', ' ')}`);
        }
      }

      if (needsReview.length > 0) {
        console.log('');
        console.log('  Review low-confidence extractions:');
        console.log(`    cascade agent review --pod ${podDirArg}`);
      }

      console.log('');

      // ── 8. Clean up auto-spawned agent ──────────────────────────────────

      if (spawnedAgent) {
        spawnedAgent.kill();
        spawnedAgent = null;
        console.log('  (stopped auto-spawned cascade-agent)');
      }
    });
}

// ── Turtle generation ─────────────────────────────────────────────────────────

const TTL_PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

/**
 * Build Turtle for auto-accepted entities.
 *
 * Each extracted entity is typed with its domain RDF class (e.g. clinical:Medication)
 * rather than cascade:AIExtractionActivity. A separate cascade:AIExtractionActivity
 * node is emitted per extraction call and linked via prov:wasGeneratedBy, keeping
 * provenance and entity data properly separated.
 */
function buildAIExtractedTurtle(
  accepted: Array<{ block: NarrativeBlock; entity: ExtractedEntity; result: ExtractionResult }>,
  existingContent: string,
): string {
  const header = existingContent.trim()
    ? existingContent.trim() + '\n\n'
    : TTL_PREFIXES + '# AI-extracted clinical entities — auto-accepted (confidence >= 0.85)\n# Review with: cascade agent review\n\n';

  const now = new Date().toISOString();
  const lines: string[] = [header];

  // Emit one activity node per unique (section, narrativeText, modelId) triple
  // so that multiple entities from the same extraction call share a single activity.
  const emittedActivities = new Set<string>();

  for (const { block, entity, result } of accepted) {
    const activityUri = deterministicActivityUri(block.section, block.narrativeText, result.modelId);
    const entityUri   = deterministicExtractionUri(block.section, entity.displayName, entity.sourceText);
    const rdfType     = entityRdfType(entity.type);

    if (!emittedActivities.has(activityUri)) {
      emittedActivities.add(activityUri);
      lines.push(`<${activityUri}> a cascade:AIExtractionActivity ;`);
      lines.push(`    cascade:extractionModel "${escapeString(result.modelId)}" ;`);
      lines.push(`    cascade:sourceNarrativeSection "${block.section}" ;`);
      lines.push(`    cascade:extractionConfidence "${entity.confidence}"^^xsd:decimal ;`);
      lines.push(`    prov:generatedAtTime "${now}"^^xsd:dateTime .\n`);
    }

    // Entity record: typed with its domain class, linked back to the extraction activity.
    // cascade:dataProvenance cascade:AIExtracted marks this as AI-generated per the ontology.
    lines.push(`<${entityUri}> a ${rdfType} ;`);
    lines.push(`    rdfs:label "${escapeString(entity.displayName)}" ;`);
    lines.push(`    cascade:dataProvenance cascade:AIExtracted ;`);
    lines.push(`    prov:wasGeneratedBy <${activityUri}> .\n`);
  }

  return lines.join('\n');
}

/**
 * Build Turtle for discarded entities (confidence < 0.50).
 *
 * Uses cascade:AIDiscardedExtraction so these records can be queried
 * and audited separately from accepted extractions.
 */
function buildDiscardedTurtle(
  discarded: Array<{ block: NarrativeBlock; entity: ExtractedEntity }>,
  existingContent: string,
): string {
  const header = existingContent.trim()
    ? ''
    : TTL_PREFIXES + '# Discarded AI extractions (confidence < 0.50)\n\n';

  const now = new Date().toISOString();
  const lines: string[] = [header];

  for (const { block, entity } of discarded) {
    const id = deterministicExtractionUri(block.section, entity.displayName, entity.sourceText) + '-discarded';
    lines.push(`<${id}> a cascade:AIDiscardedExtraction ;`);
    lines.push(`    rdfs:label "${escapeString(entity.displayName)}" ;`);
    lines.push(`    cascade:discardedEntityType "${escapeString(entity.type)}" ;`);
    lines.push(`    cascade:discardedFrom "${block.section}" ;`);
    lines.push(`    cascade:discardConfidence "${entity.confidence}"^^xsd:decimal ;`);
    lines.push(`    cascade:discardedAt "${now}"^^xsd:dateTime .\n`);
  }

  return lines.join('\n');
}

function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}
