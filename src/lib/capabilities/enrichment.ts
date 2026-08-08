/**
 * Hand-authored DECORATION for generated descriptors. Never a source of commands.
 *
 * Every entry here is keyed by a command path that `describeCommands` already
 * produced from the commander registry. If a key does not resolve to a
 * registered command, the entry is dead weight that describes nothing — which
 * is exactly how `cascade_pod_import` came to be advertised for months as an
 * MCP tool that had never existed. `tests/capabilities-registry.test.ts` fails,
 * naming the key, the moment that happens.
 *
 * The direction is the point: **enrichment cannot introduce a command.** The
 * `CommandEnrichment` type has no name, no usage and no parameters, so the only
 * way a command reaches the capabilities document is by being registered on the
 * program that `cascade` actually parses with. Adding a verb to the CLI
 * describes it automatically; adding a row here describes nothing.
 *
 * What belongs here: examples, output schemas, and the semantics an agent needs
 * to use a verb safely. What does not: anything commander already knows
 * (names, arguments, options, defaults) — that is generated, and a copy of it
 * here would be a second thing to keep in sync.
 */

import type { EnrichmentTable } from './descriptors.js';
import type { McpEnrichmentTable } from '../mcp/describe.js';

export const COMMAND_ENRICHMENT: EnrichmentTable = {
  validate: {
    examples: ['cascade validate record.ttl', 'cascade --json validate ./data/'],
  },

  convert: {
    examples: [
      'cascade convert patient.json --from fhir --to turtle',
      'cat data.json | cascade convert --from fhir --to turtle',
    ],
  },

  reconcile: {
    examples: [
      'cascade reconcile system-a.ttl system-b.ttl --output merged.ttl --report report.json',
      'cascade reconcile vm.ttl swedish.ttl --trust 0.9,0.7 --output merged.ttl',
    ],
  },

  'pod init': {
    examples: ['cascade pod init ./my-pod'],
  },

  'pod info': {
    examples: ['cascade pod info ./my-pod', 'cascade --json pod info ./my-pod'],
  },

  'pod export': {
    examples: ['cascade pod export ./my-pod', 'cascade pod export ./my-pod --format directory'],
  },

  'pod import': {
    examples: [
      'cascade pod import ./my-pod patient.json --source-system "Virginia Mason"',
      'cascade pod import ./my-pod vm.json swedish.json --source-system "primary,specialist" --report report.json',
      'cascade pod import ./my-pod records.ttl --no-reconcile',
    ],
  },

  'pod query': {
    examples: [
      'cascade pod query ./my-pod --medications --json',
      'cascade pod query ./my-pod --encounters --conditions --json',
      'cascade pod query ./my-pod --all --json',
    ],
    outputSchema: {
      description: 'JSON output structure for --json flag',
      shape: '{ pod: string, dataTypes: { [type]: { count: number, file: string, records: Record[] } } }',
      recordShape: '{ id: string, type: string, properties: { [prefixed-property]: string } }',
      propertyPrefixes: {
        'health:':
          'wellness/device data — health:testName, health:resultValue, health:resultUnit, health:performedDate, health:testCode (LOINC URI), health:conditionName, health:conditionCategory (FHIR category: problem-list-item|encounter-diagnosis|social-history), health:snomedSemanticTag (semantic type from SNOMED display name: disorder|finding|situation|procedure|observable entity), health:status (active/inactive/resolved), health:onsetDate, health:medicationName, health:isActive (true/false string), health:rxNormCode',
        'clinical:':
          'EHR-imported clinical data — clinical:encounterDate, clinical:encounterType, clinical:procedureName, clinical:procedureDate, clinical:drugCode, clinical:clinicalIntent',
        'core:':
          'provenance — core:sourceSystem, core:dataProvenance, core:schemaVersion, core:reconciliationStatus, core:mergedSources',
      },
      jqExamples: [
        '# Clinical conditions only (excludes social findings): cascade pod query <pod> --conditions --json | jq \'[.dataTypes.conditions.records[] | select(.properties["health:status"] == "active" and .properties["health:snomedSemanticTag"] == "disorder") | .properties["health:conditionName"]]\'',
        '# All active conditions including findings: cascade pod query <pod> --conditions --json | jq \'[.dataTypes.conditions.records[] | select(.properties["health:status"] == "active") | {name: .properties["health:conditionName"], type: .properties["health:snomedSemanticTag"]}]\'',
        '# HbA1c trend (most recent first): cascade pod query <pod> --lab-results --json | jq \'[.dataTypes["lab-results"].records[] | select(.properties["health:testName"] | ascii_downcase | test("a1c")) | {date: .properties["health:performedDate"], value: .properties["health:resultValue"], unit: .properties["health:resultUnit"]}] | sort_by(.date) | reverse\'',
        '# Active medications: cascade pod query <pod> --medications --json | jq \'[.dataTypes.medications.records[] | select(.properties["health:isActive"] == "true") | .properties["health:medicationName"]]\'',
        '# Medications with source provenance: cascade pod query <pod> --medications --json | jq \'[.dataTypes.medications.records[] | {name: .properties["health:medicationName"], active: .properties["health:isActive"], sources: .properties["core:mergedSources"]}]\'',
      ],
      shellQuotingNote:
        'Always pipe pod query output through jq rather than reading raw JSON (output can be very large). Use ["key"] bracket notation in jq filters to avoid shell quoting issues. If a filter is complex, write it to /tmp/filter.jq and run: cascade pod query <pod> --TYPE --json | jq -f /tmp/filter.jq',
    },
  },

  'pod doctor': {
    // Commander's one-liner cannot say what this verb will and will not touch,
    // and an agent reaching for it is by definition looking at a damaged pod.
    description:
      'Diagnose a damaged Cascade Pod and, with --write, repair files whose only defect is a missing @prefix declaration. This is the recovery path when add-record, erase or import refuse a bucket that will not parse. Dry run by default; only ever PREPENDS declarations, never rewrites existing bytes; never invents a namespace.',
    examples: ['cascade pod doctor ./my-pod', 'cascade pod doctor ./my-pod --write', 'cascade --json pod doctor ./my-pod'],
    outputSchema: {
      description: 'JSON report structure for --json',
      shape: '{ pod, encrypted, mode: "dry-run"|"write", scanned, healthy, repaired, repairable, refused, unreadable, findings: Finding[] }',
      findingShape:
        '{ file, status: "repairable"|"repaired"|"refused"|"unreadable", damage, reason, nextStep?, missingPrefixes?, triples?, preservedBytes?, backup? }',
      exitCodes: '0 = nothing wrong or everything repaired; 1 = damage remains (or no pod at that path); 2 = the pod could not be opened',
    },
  },

  'pod erase': {
    notes: [
      'Destructive and not reversible: the record bytes are removed from the bucket file. --confirm is mandatory, and a Tombstone audit marker is written in the record\'s place.',
      'For a reversible removal that keeps history, use `pod retract`, which appends a Retraction overlay instead of deleting.',
    ],
  },

  'conformance run': {
    examples: ['cascade conformance run --suite ./fixtures --self'],
  },

  serve: {
    examples: ['cascade serve --mcp', 'cascade serve --mcp --transport sse --port 3000'],
  },

  capabilities: {
    examples: ['cascade capabilities'],
  },
};

/**
 * Decoration for the MCP tools, keyed by the name the server registers.
 *
 * Same rule, same reason: an entry here cannot create a tool. The tool set
 * comes from `registerTools` and nowhere else.
 */
export const MCP_TOOL_ENRICHMENT: McpEnrichmentTable = {
  cascade_pod_read: {
    returns: 'JSON with patient profile, record counts, provenance sources',
    cliEquivalent: 'cascade pod info <pod-dir> --json',
  },
  cascade_pod_query: {
    returns: 'JSON array of matching records with properties',
    cliEquivalent: 'cascade pod query <pod-dir> --medications --json',
  },
  cascade_validate: {
    returns: 'Validation results with pass/fail per constraint',
    cliEquivalent: 'cascade validate <file-or-dir> --json',
  },
  cascade_convert: {
    returns: 'Converted output',
    cliEquivalent: 'cascade convert --from fhir --to cascade <file>',
  },
  cascade_write: {
    returns: 'Record URI, file path, provenance metadata',
  },
  cascade_capabilities: {
    returns: 'This capabilities document',
  },
};
