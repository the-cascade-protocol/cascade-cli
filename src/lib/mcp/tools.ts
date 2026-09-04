/**
 * MCP tool definitions and handlers for the Cascade Protocol agent server.
 *
 * Exposes 6 tools:
 *   - cascade_pod_read: Read full Pod contents
 *   - cascade_pod_query: Query records by data type
 *   - cascade_validate: Validate Turtle against SHACL shapes
 *   - cascade_convert: Convert between FHIR and Cascade formats
 *   - cascade_write: Write a record to a Pod with provenance
 *   - cascade_capabilities: Describe all available tools
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DATA_TYPES } from '../../commands/pod/helpers.js';
import {
  openPod,
  resolvePodDir,
  isDirectory,
  fileExists,
  PodReadLedger,
  PodUnreadableError,
  PodFilesUnreadableError,
} from '../pod-read.js';
import { loadShapes, validateTurtle, validateFile, findTurtleFiles } from '../shacl-validator.js';
import { convert } from '../fhir-converter/index.js';
import { writeAuditEntry, createAuditEntry } from './audit.js';
import { describeMcpTools } from './describe.js';
import { MCP_TOOL_ENRICHMENT } from '../capabilities/enrichment.js';
import { CLI_VERSION, CLI_PACKAGE_NAME } from '../version.js';

// ─── Shared State ────────────────────────────────────────────────────────────

/** Default Pod path from environment or CLI option */
let defaultPodPath: string | undefined;

/** Lazily loaded SHACL shapes */
let shapesCache: { store: import('n3').Store; shapeFiles: string[] } | undefined;

function getShapes() {
  if (!shapesCache) {
    shapesCache = loadShapes();
  }
  return shapesCache;
}

export function setDefaultPodPath(podPath: string): void {
  defaultPodPath = podPath;
}

function resolvePod(pathArg?: string): string {
  const raw = pathArg ?? defaultPodPath;
  if (!raw) {
    throw new Error(
      'No Pod path specified. Pass a "path" argument or set CASCADE_POD_PATH environment variable.',
    );
  }
  return resolvePodDir(raw);
}

/**
 * Validate that a resolved path stays within an allowed boundary directory.
 * Prevents path traversal attacks (e.g., "../../etc/passwd").
 */
export function validatePathBoundary(resolvedPath: string, boundary: string): boolean {
  const normalizedPath = path.resolve(resolvedPath);
  const normalizedBoundary = path.resolve(boundary);
  return normalizedPath.startsWith(normalizedBoundary + path.sep) || normalizedPath === normalizedBoundary;
}

/** Format a successful tool response with JSON content. */
function toolResponse(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** Format an error tool response, optionally with machine-readable detail. */
function toolError(
  message: string,
  detail: Record<string, unknown> = {},
): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, ...detail }) }],
  };
}

/**
 * Wrapper for tool handlers that need Pod directory resolution.
 * Handles: pod path resolution, directory check, error catching, response formatting.
 *
 * A pod that could not be opened or read comes back as a typed ERROR, never as
 * a successful result whose counts happen to be zero. These tools feed an agent
 * that will restate whatever it is handed, so "totalRecords: 0" over a sealed
 * pod is not a soft failure — it is a confident false statement about someone's
 * health record.
 */
function withPodHandler(
  handler: (absDir: string, args: Record<string, unknown>) => Promise<unknown>,
): (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return async (args) => {
    try {
      const absDir = resolvePod(args.path as string | undefined);
      if (!(await isDirectory(absDir))) {
        return toolError('Pod directory not found. Check the path argument or CASCADE_POD_PATH variable.');
      }
      const result = await handler(absDir, args);
      return toolResponse(result);
    } catch (err: unknown) {
      if (err instanceof PodUnreadableError) {
        return toolError(err.message, {
          code: 'pod-unreadable',
          reason: err.reason,
          encrypted: true,
          readable: false,
        });
      }
      if (err instanceof PodFilesUnreadableError) {
        return toolError(err.message, {
          code: 'pod-files-unreadable',
          readable: false,
          files: err.failures.map((f) => f.file),
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return toolError(message);
    }
  };
}

// ─── Tool Registration ──────────────────────────────────────────────────────

/**
 * Register all Cascade MCP tools on the given McpServer instance.
 */
export function registerTools(server: McpServer): void {
  registerPodRead(server);
  registerPodQuery(server);
  registerValidate(server);
  registerConvert(server);
  registerWrite(server);
  registerCapabilities(server);
}

// ─── cascade_pod_read ────────────────────────────────────────────────────────

/**
 * The `cascade_pod_read` handler, exported so the read-conformance battery can
 * put it through the same failure matrix as the CLI verbs.
 */
export const podReadHandler = withPodHandler(async (absDir) => {
  // One DEK for the whole handler. Reading a sealed pod keyless is what made
  // this tool report an encrypted pod as an empty one.
  const reader = await openPod(absDir);
  const ledger = new PodReadLedger();

  const { profile, failures: profileFailures } = await reader.readPatientProfile();
  for (const failure of profileFailures) {
    ledger.attempt();
    ledger.record(failure);
  }

  const recordCounts: Record<string, number> = {};
  const provenanceSources = new Set<string>();
  let totalRecords = 0;

  for (const [typeName, typeInfo] of Object.entries(DATA_TYPES)) {
    const filePath = path.join(absDir, typeInfo.directory, typeInfo.filename);
    if (!(await fileExists(filePath))) continue;

    ledger.attempt();
    const read = reader.readRecords(filePath);
    if (!read.ok) {
      ledger.record(read.failure);
      continue;
    }
    const { records } = read.value;
    if (records.length > 0) {
      recordCounts[typeName] = records.length;
      totalRecords += records.length;

      for (const rec of records) {
        const prov = rec.properties['cascade:dataProvenance'];
        if (prov) provenanceSources.add(prov);
      }
    }
  }

  // Before the audit entry and before the response: a partial count returned as
  // a whole one is the failure this tool is being fixed for.
  ledger.throwIfFatal(absDir);

  return buildPodReadResult(absDir, profile, recordCounts, provenanceSources, totalRecords);
});

function registerPodRead(server: McpServer): void {
  server.tool(
    'cascade_pod_read',
    'Read a Cascade Pod and return a JSON summary of all contents including patient profile, record counts, provenance sources, and data inventory.',
    {
      path: z.string().optional().describe('Path to the Pod directory. Uses CASCADE_POD_PATH if omitted.'),
    },
    podReadHandler,
  );
}

/** Assemble the `cascade_pod_read` payload and write its audit entry. */
async function buildPodReadResult(
  absDir: string,
  profile: { name?: string; dateOfBirth?: string; age?: string; schemaVersion?: string },
  recordCounts: Record<string, number>,
  provenanceSources: Set<string>,
  totalRecords: number,
): Promise<unknown> {
  await writeAuditEntry(absDir, createAuditEntry('pod_read', ['all'], totalRecords));

  return {
    pod: absDir,
    patient: {
      name: profile.name ?? 'Unknown',
      dateOfBirth: profile.dateOfBirth,
      age: profile.age,
      schemaVersion: profile.schemaVersion,
    },
    totalRecords,
    recordCounts,
    provenanceSources: Array.from(provenanceSources),
    directories: {
      clinical: Object.entries(recordCounts)
        .filter(([k]) => DATA_TYPES[k]?.directory === 'clinical')
        .map(([k, v]) => ({ type: k, count: v })),
      wellness: Object.entries(recordCounts)
        .filter(([k]) => DATA_TYPES[k]?.directory === 'wellness')
        .map(([k, v]) => ({ type: k, count: v })),
    },
  };
}

// ─── cascade_pod_query ───────────────────────────────────────────────────────

/**
 * The `cascade_pod_query` handler, exported for the read-conformance battery.
 */
export const podQueryHandler = withPodHandler(async (absDir, args) => {
  const dataType = args.dataType as string;
  const typesToQuery = dataType === 'all' ? Object.keys(DATA_TYPES) : [dataType];
  const results: Record<string, { count: number; file: string; records: Array<{ id: string; type: string; label?: string; properties: Record<string, string> }> }> = {};
  let totalRecords = 0;

  // One DEK for the whole handler, resolved before the first read.
  const reader = await openPod(absDir);
  const ledger = new PodReadLedger();

  for (const typeName of typesToQuery) {
    const typeInfo = DATA_TYPES[typeName];
    if (!typeInfo) continue;

    const filePath = path.join(absDir, typeInfo.directory, typeInfo.filename);
    if (!(await fileExists(filePath))) continue;

    ledger.attempt();
    const read = reader.readRecords(filePath);
    if (!read.ok) {
      ledger.record(read.failure);
      continue;
    }
    const { records } = read.value;
    if (records.length > 0) {
      results[typeName] = {
        count: records.length,
        file: `${typeInfo.directory}/${typeInfo.filename}`,
        records: records.map((r) => ({
          id: r.id,
          type: r.type,
          label: r.label,
          properties: r.properties,
        })),
      };
      totalRecords += records.length;
    }
  }

  // A count drawn from the files that happened to open is not the pod's count.
  ledger.throwIfFatal(absDir);

  await writeAuditEntry(absDir, createAuditEntry('pod_query', typesToQuery, totalRecords));

  return { pod: absDir, dataType, dataTypes: results, totalRecords };
});

function registerPodQuery(server: McpServer): void {
  server.tool(
    'cascade_pod_query',
    'Query records from a Cascade Pod by data type. Returns JSON array of matching records with their properties and provenance.',
    {
      path: z.string().optional().describe('Path to the Pod directory. Uses CASCADE_POD_PATH if omitted.'),
      dataType: z
        .enum([
          'medications', 'conditions', 'allergies', 'lab-results',
          'immunizations', 'vital-signs', 'supplements', 'insurance',
          'patient-profile', 'heart-rate', 'blood-pressure',
          'activity', 'sleep', 'all',
        ])
        .describe('Data type to query, or "all" for everything.'),
    },
    podQueryHandler,
  );
}

// ─── cascade_validate ────────────────────────────────────────────────────────

function registerValidate(server: McpServer): void {
  server.tool(
    'cascade_validate',
    'Validate Cascade Protocol Turtle data against SHACL shapes. Accepts either a file/directory path or inline Turtle content.',
    {
      path: z.string().optional().describe('Path to a Turtle file or directory to validate.'),
      content: z.string().optional().describe('Inline Turtle content to validate (alternative to path).'),
    },
    async ({ path: filePath, content }) => {
      if (!filePath && !content) {
        return toolError('Either "path" or "content" argument is required.');
      }

      try {
        const { store: shapesStore, shapeFiles } = getShapes();

        if (content) {
          const result = validateTurtle(content, shapesStore, shapeFiles, '<inline>');
          return toolResponse(result);
        }

        // Validate file or directory — with path containment check
        const absPath = path.resolve(process.cwd(), filePath!);
        if (!validatePathBoundary(absPath, process.cwd())) {
          return toolError('Path is outside the allowed boundary. Paths must resolve within the current working directory.');
        }

        const stat = await fs.stat(absPath).catch(() => null);
        if (!stat) {
          return toolError('Path not found. Check that the file or directory exists.');
        }

        if (stat.isFile()) {
          const result = validateFile(absPath, shapesStore, shapeFiles);
          return toolResponse(result);
        }

        // Directory validation
        const ttlFiles = findTurtleFiles(absPath);
        const results = ttlFiles.map((f) => validateFile(f, shapesStore, shapeFiles));
        const allValid = results.every((r) => r.valid);

        return toolResponse({
          valid: allValid,
          filesValidated: ttlFiles.length,
          results: results.map((r) => ({
            file: r.file,
            valid: r.valid,
            issues: r.results.length,
            details: r.results,
          })),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Validation failed: ${message}`);
      }
    },
  );
}

// ─── cascade_convert ─────────────────────────────────────────────────────────

function registerConvert(server: McpServer): void {
  server.tool(
    'cascade_convert',
    'Convert between health data formats. Supports FHIR R4 JSON to Cascade Turtle/JSON-LD and vice versa.',
    {
      content: z.string().describe('The content to convert (FHIR JSON string or Cascade Turtle string).'),
      from: z.enum(['fhir', 'cascade']).describe('Source format.'),
      to: z.enum(['cascade', 'fhir']).describe('Target format.'),
      format: z.enum(['turtle', 'jsonld']).optional().describe('Output serialization format when converting to Cascade. Default: turtle.'),
    },
    async ({ content: inputContent, from, to, format }) => {
      try {
        const outputTarget = to === 'cascade' ? (format ?? 'turtle') : to;
        const outputSerialization = (format ?? 'turtle') as 'turtle' | 'jsonld';

        const result = await convert(inputContent, from, outputTarget, outputSerialization);

        if (!result.success) {
          return toolError(result.errors.join('; '));
        }

        return { content: [{ type: 'text' as const, text: result.output }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Conversion failed: ${message}`);
      }
    },
  );
}

// ─── cascade_write ───────────────────────────────────────────────────────────

function registerWrite(server: McpServer): void {
  server.tool(
    'cascade_write',
    'Write a health record to a Cascade Pod with AIExtracted provenance. The record is serialized as Turtle and appended to the appropriate file in the Pod.',
    {
      path: z.string().optional().describe('Path to the Pod directory. Uses CASCADE_POD_PATH if omitted.'),
      dataType: z
        .enum([
          'medications', 'conditions', 'allergies', 'lab-results',
          'immunizations', 'vital-signs', 'supplements',
        ])
        .describe('Type of health record to write.'),
      record: z.record(z.string(), z.unknown()).describe('JSON object with record fields (e.g., { "name": "Aspirin", "dose": "81 mg" }).'),
      provenance: z.object({
        agentId: z.string().optional().describe('Identifier of the AI agent writing the data.'),
        reason: z.string().optional().describe('Reason for creating this record.'),
        confidence: z.number().min(0).max(1).optional().describe('Agent confidence level (0.0-1.0).'),
        sourceRecords: z.array(z.string()).optional().describe('URIs of source records used to derive this data.'),
      }).optional().describe('Provenance metadata for the written record.'),
    },
    withPodHandler(async (absDir, args) => {
      const dataType = args.dataType as string;
      const record = args.record as Record<string, unknown>;
      const provenance = args.provenance as { agentId?: string; reason?: string; confidence?: number; sourceRecords?: string[] } | undefined;

      const typeInfo = DATA_TYPES[dataType];
      if (!typeInfo) {
        throw new Error(`Unknown data type: ${dataType}`);
      }

      const uuid = randomUUID();
      const recordUri = `urn:uuid:${uuid}`;
      const timestamp = new Date().toISOString();

      const turtle = buildRecordTurtle(recordUri, dataType, typeInfo, record, provenance, timestamp);

      const targetDir = path.join(absDir, typeInfo.directory);
      const targetFile = path.join(targetDir, typeInfo.filename);

      // Path containment: verify target stays within the Pod
      if (!validatePathBoundary(targetFile, absDir)) {
        throw new Error('Target file path is outside the Pod directory.');
      }

      await fs.mkdir(targetDir, { recursive: true });

      let fileExistsFlag = false;
      try {
        await fs.access(targetFile);
        fileExistsFlag = true;
      } catch {
        // File doesn't exist
      }

      if (fileExistsFlag) {
        await fs.appendFile(targetFile, '\n' + turtle, 'utf-8');
      } else {
        const prefixes = generatePrefixes();
        await fs.writeFile(targetFile, prefixes + '\n' + turtle, 'utf-8');
      }

      await writeAuditEntry(
        absDir,
        createAuditEntry('write', [dataType], 1, provenance?.agentId),
      );

      return {
        success: true,
        recordUri,
        file: `${typeInfo.directory}/${typeInfo.filename}`,
        provenance: {
          type: 'AIExtracted',
          agentId: provenance?.agentId ?? 'unknown-agent',
          timestamp,
          reason: provenance?.reason,
          confidence: provenance?.confidence,
        },
      };
    }),
  );
}

// ─── cascade_capabilities ────────────────────────────────────────────────────

function registerCapabilities(server: McpServer): void {
  server.tool(
    'cascade_capabilities',
    'Describe all available Cascade Protocol MCP tools, their parameters, and usage examples. Use this as the entry point for discovering what the server can do.',
    {},
    async () => {
      // Derived from registerTools, not written out again. This document and
      // `cascade capabilities` were two hand-maintained mirrors of one registry
      // and had drifted apart from it and from each other.
      const tools = describeMcpTools(registerTools, MCP_TOOL_ENRICHMENT);

      const capabilities = {
        name: CLI_PACKAGE_NAME,
        version: CLI_VERSION,
        description: 'Cascade Protocol MCP Server — Local-first AI agent access to structured health data.',
        protocol: 'https://cascadeprotocol.org',
        securityModel: {
          // Scoped to the tools this server exposes, which is what a client of
          // this document is asking about. It is NOT a claim about the CLI as a
          // whole: `advisory feed pull` and `pod extract` do make outbound
          // calls, and neither is reachable through an MCP tool.
          networkCalls: 'zero — every tool on this server reads and writes the local filesystem only',
          dataStorage: 'local filesystem only',
          provenance: 'all agent-written data tagged with AIExtracted provenance',
          auditLog: 'all operations logged to provenance/audit-log.ttl in the Pod',
        },
        tools,
        namespaces: {
          cascade: 'https://ns.cascadeprotocol.org/core/v1#',
          clinical: 'https://ns.cascadeprotocol.org/clinical/v1#',
          health: 'https://ns.cascadeprotocol.org/health/v1#',
          checkup: 'https://ns.cascadeprotocol.org/checkup/v1#',
          pots: 'https://ns.cascadeprotocol.org/pots/v1#',
          coverage: 'https://ns.cascadeprotocol.org/coverage/v1#',
        },
        provenanceTypes: [
          'cascade:ClinicalGenerated — Data from clinical/EHR sources',
          'cascade:DeviceGenerated — Data from wearable/medical devices',
          'cascade:SelfReported — Patient-entered data',
          'cascade:AIExtracted — written by an AI agent, including everything cascade_write records',
        ],
        cliEquivalents: Object.fromEntries(
          tools.filter((tool) => tool.cliEquivalent).map((tool) => [tool.name, tool.cliEquivalent]),
        ),
      };

      return { content: [{ type: 'text', text: JSON.stringify(capabilities, null, 2) }] };
    },
  );
}

// ─── Turtle Generation Helpers ───────────────────────────────────────────────

/** Generate namespace prefixes for a new Turtle file. */
export function generatePrefixes(): string {
  return `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
@prefix coverage: <https://ns.cascadeprotocol.org/coverage/v1#> .
@prefix fhir: <http://hl7.org/fhir/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
`;
}

/** Map from data type key to rdf:type and name predicate. */
export const TYPE_MAPPING: Record<string, { rdfType: string; nameKey: string; namePred: string }> = {
  medications: { rdfType: 'clinical:Medication', nameKey: 'name', namePred: 'clinical:drugName' },
  conditions: { rdfType: 'health:ConditionRecord', nameKey: 'name', namePred: 'health:conditionName' },
  allergies: { rdfType: 'health:AllergyRecord', nameKey: 'name', namePred: 'health:allergen' },
  'lab-results': { rdfType: 'health:LabResultRecord', nameKey: 'name', namePred: 'health:testName' },
  immunizations: { rdfType: 'health:ImmunizationRecord', nameKey: 'name', namePred: 'health:vaccineName' },
  'vital-signs': { rdfType: 'clinical:VitalSign', nameKey: 'type', namePred: 'clinical:vitalType' },
  supplements: { rdfType: 'clinical:Supplement', nameKey: 'name', namePred: 'clinical:supplementName' },
};

/** Property name mapping from JSON keys to Turtle predicates. */
export const PROPERTY_PREDICATES: Record<string, string> = {
  dose: 'clinical:dosage',
  frequency: 'clinical:frequency',
  route: 'clinical:route',
  prescriber: 'clinical:prescriber',
  startDate: 'health:startDate',
  endDate: 'health:endDate',
  isActive: 'clinical:status',
  status: 'clinical:status',
  onsetDate: 'health:onsetDate',
  reaction: 'health:reaction',
  severity: 'health:allergySeverity',
  allergyCategory: 'health:allergyCategory',
  resultValue: 'health:resultValue',
  resultUnit: 'health:resultUnit',
  referenceRange: 'health:referenceRange',
  interpretation: 'health:interpretation',
  performedDate: 'health:performedDate',
  testCode: 'health:testCode',
  vaccineDate: 'health:administrationDate',
  administrationDate: 'health:administrationDate',
  lotNumber: 'health:lotNumber',
  site: 'health:site',
  manufacturer: 'health:manufacturer',
  vitalType: 'clinical:vitalType',
  value: 'health:resultValue',
  unit: 'health:resultUnit',
  notes: 'health:notes',
  indication: 'clinical:indication',
  medicationClass: 'health:medicationClass',
  conditionClass: 'health:conditionClass',
  form: 'clinical:form',
  evidenceStrength: 'clinical:evidenceStrength',
  reasonForUse: 'clinical:reasonForUse',
};

/**
 * Build a Turtle serialization for a record.
 */
export function buildRecordTurtle(
  recordUri: string,
  dataType: string,
  _typeInfo: typeof DATA_TYPES[string],
  record: Record<string, unknown>,
  provenance: { agentId?: string; reason?: string; confidence?: number; sourceRecords?: string[] } | undefined,
  timestamp: string,
): string {
  const typeMapping = TYPE_MAPPING[dataType];
  if (!typeMapping) {
    throw new Error(`No type mapping for data type: ${dataType}`);
  }

  const lines: string[] = [];
  lines.push(`<${recordUri}> a ${typeMapping.rdfType} ;`);

  // Add the name/label
  const nameValue = record[typeMapping.nameKey] ?? record['name'];
  if (nameValue) {
    lines.push(`    ${typeMapping.namePred} ${escapeTurtleString(String(nameValue))} ;`);
  }

  // Add mapped properties
  for (const [key, value] of Object.entries(record)) {
    if (key === typeMapping.nameKey || key === 'name') continue; // Already handled
    const pred = PROPERTY_PREDICATES[key];
    if (pred && value !== undefined && value !== null) {
      lines.push(`    ${pred} ${formatTurtleValue(key, value)} ;`);
    }
  }

  // Always cascade:AIExtracted for agent-written data. The agent does not
  // choose its own provenance: an agent that could label its output
  // EHRVerified would defeat the point of recording provenance at all.
  //
  // AIExtracted is the vocabulary's only DataProvenance value for
  // agent-authored content, and the only one admitted by the `sh:in`
  // constraint every record shape puts on cascade:dataProvenance. This line
  // used to emit `cascade:AIGenerated`, a term declared nowhere, so every
  // record written through this path violated its own shape.
  lines.push(`    cascade:dataProvenance cascade:AIExtracted ;`);
  lines.push(`    cascade:schemaVersion "1.3" ;`);

  // Add provenance metadata as blank node
  const agentId = provenance?.agentId ?? 'unknown-agent';
  const reason = provenance?.reason ?? 'Agent-generated record';
  lines.push(`    prov:wasGeneratedBy [`);
  // A bare prov:Activity, deliberately. The obvious-looking subclass here is
  // cascade:AIExtractionActivity, but that class means an LLM extraction run
  // over narrative text and its shape requires cascade:extractionModel and
  // cascade:extractionConfidence — neither of which cascade_write has, because
  // it is not extracting from a document. Typing the node as one would trade an
  // undeclared class for a false claim about how the record was produced. The
  // record's own cascade:dataProvenance above is what marks it agent-written.
  lines.push(`        a prov:Activity ;`);
  lines.push(`        prov:wasAssociatedWith "${agentId}" ;`);
  lines.push(`        prov:atTime "${timestamp}"^^xsd:dateTime ;`);
  lines.push(`        cascade:generationReason ${escapeTurtleString(reason)}`);

  if (provenance?.confidence !== undefined) {
    lines.push(`        ; cascade:confidence "${provenance.confidence}"^^xsd:double`);
  }

  if (provenance?.sourceRecords && provenance.sourceRecords.length > 0) {
    const sources = provenance.sourceRecords.map((s) => `<${s}>`).join(', ');
    lines.push(`        ; prov:used ${sources}`);
  }

  // Close blank node and record
  lines.push(`    ] .`);

  return lines.join('\n');
}

/** Escape a string for Turtle literal. Handles all standard escape sequences. */
export function escapeTurtleString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  // Use triple-quoted long literal for very long strings or strings with embedded newlines
  if (value.length > 200 || value.includes('\n')) {
    const longEscaped = value
      .replace(/\\/g, '\\\\')
      .replace(/"""/g, '\\"\\"\\"');
    return `"""${longEscaped}"""`;
  }
  return `"${escaped}"`;
}

/** Format a value for Turtle based on key name / value type. */
export function formatTurtleValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') {
    return `${value}`;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `${value}` : `"${value}"^^xsd:double`;
  }
  // Date-like keys get xsd:dateTime typing
  if (key.toLowerCase().includes('date') || key.toLowerCase().includes('time')) {
    return `"${String(value)}"^^xsd:dateTime`;
  }
  return escapeTurtleString(String(value));
}

// UUID generation uses crypto.randomUUID() — cryptographically secure, built into Node.js 14.17+.
