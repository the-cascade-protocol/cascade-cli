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
import * as path from 'path';
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
      const discardedEntities: Array<{ block: NarrativeBlock; entity: ExtractedEntity }> = [];
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

          // Route entities by confidence. All entities in a block are processed;
          // at most one review queue entry is created per block (the entry contains
          // the full result so the reviewer sees all medium-confidence entities).
          let accepted = 0, review = 0, discarded = 0;
          let addedToReview = false;

          for (const entity of result.entities) {
            if (entity.confidence >= 0.85) {
              autoAccepted.push({ block, entity, result });
              accepted++;
            } else if (entity.confidence >= 0.50) {
              if (!addedToReview) {
                // One review entry per block; the full result contains all entities
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
              review++;
            } else {
              discardedEntities.push({ block, entity });
              discarded++;
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

      const indexTtlPath = path.join(podDir, 'index.ttl');
      const newFiles: string[] = [];

      // 5a. Auto-accepted → clinical/ai-extracted.ttl
      if (autoAccepted.length > 0) {
        const extractedPath = path.join(podDir, 'clinical', 'ai-extracted.ttl');
        const isNew = !(await fileExists(extractedPath));
        const existing = isNew ? '' : await fs.readFile(extractedPath, 'utf-8');
        await fs.writeFile(extractedPath, buildAIExtractedTurtle(autoAccepted, existing), 'utf-8');
        if (isNew) newFiles.push('clinical/ai-extracted.ttl');
      }

      // 5b. Needs-review → analysis/review-queue.json (append, deduplicate by id)
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

      // 5c. Discarded → analysis/discarded-extractions.ttl (actual RDF records)
      if (discardedEntities.length > 0) {
        const discardPath = path.join(podDir, 'analysis', 'discarded-extractions.ttl');
        const isNew = !(await fileExists(discardPath));
        const existing = isNew ? '' : await fs.readFile(discardPath, 'utf-8');
        await fs.appendFile(discardPath, buildDiscardedTurtle(discardedEntities, existing), 'utf-8');
        if (isNew) newFiles.push('analysis/discarded-extractions.ttl');
      }

      // 5d. Update pod index.ttl for any new files written this run
      if (newFiles.length > 0 && await fileExists(indexTtlPath)) {
        for (const relPath of newFiles) {
          await appendIndexContains(indexTtlPath, relPath);
        }
      }

      // ── 6. Summary ────────────────────────────────────────────────────────

      console.log('');
      console.log(`  ✓ Auto-accepted  ${autoAccepted.length} entities → clinical/ai-extracted.ttl`);
      if (needsReview.length > 0) {
        console.log(`  ⟳ Needs review   ${needsReview.length} block(s) → analysis/review-queue.json`);
      }
      if (discardedEntities.length > 0) {
        console.log(`  ✗ Discarded      ${discardedEntities.length} entities (confidence < 0.50)`);
      }
      if (errorCount > 0) {
        console.log(`  ! Errors         ${errorCount} block(s) failed`);
      }

      if (needsReview.length > 0) {
        console.log('');
        console.log('  Review low-confidence extractions:');
        console.log(`    cascade agent review --pod ${podDirArg}`);
      }

      console.log('');
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
 * Each extracted entity is typed with its domain RDF class (e.g. health:MedicationRecord)
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
