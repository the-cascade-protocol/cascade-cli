/**
 * Shared helpers for pod subcommands.
 *
 * Identity, display-formatting and export utilities used by several pod
 * subcommands. The record-reading half of this module now lives in
 * `lib/pod-read.ts` — one door, one DEK, one rule about what a read failure
 * means — and this file only re-exports the pieces whose import path many
 * modules and tests already depend on.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { CASCADE_NAMESPACES } from '../../lib/turtle-parser.js';
import { openPod } from '../../lib/pod-read.js';

// ─── Re-exports ──────────────────────────────────────────────────────────────
//
// The registry of record files and the pod file-system helpers moved into
// `lib/` so the read layer can use them without importing a command module.

export { DATA_TYPES, type DataTypeInfo } from '../../lib/pod-data-types.js';
export {
  resolvePodDir,
  isDirectory,
  fileExists,
  discoverTtlFiles,
} from '../../lib/pod-read.js';

// Re-export CASCADE_NAMESPACES for convenience
export { CASCADE_NAMESPACES };

// ─── Identity Helpers ────────────────────────────────────────────────────────

/**
 * Name parts written into a pod's profile/card.ttl identity block.
 * `fullName` maps to foaf:name; the optional given/family parts map to
 * foaf:givenName / foaf:familyName.
 */
export interface CardIdentityName {
  fullName?: string;
  givenName?: string;
  familyName?: string;
}

/**
 * Derive card.ttl identity parts from a single display-name string.
 *
 * A given/family split is only recorded when it is trivially derivable: exactly
 * two whitespace-separated tokens (e.g. "Jane Doe"). A single token, or three or
 * more tokens (middle names, particles, suffixes), records foaf:name only rather
 * than guessing which token is the family name. Internal whitespace is collapsed
 * to single spaces; an empty or whitespace-only string yields no parts.
 */
export function deriveCardIdentityName(name: string): CardIdentityName {
  const fullName = name.trim().replace(/\s+/g, ' ');
  if (!fullName) return {};
  const tokens = fullName.split(' ');
  if (tokens.length === 2) {
    return { fullName, givenName: tokens[0], familyName: tokens[1] };
  }
  return { fullName };
}

/**
 * Replace the commented-out identity placeholder block in a profile/card.ttl
 * document with concrete foaf name triples, returning the updated Turtle. When
 * no name parts are supplied the document is returned unchanged.
 *
 * Shared by `pod init --owner-name`, `pod profile set-name`, and `pod import`'s
 * profile-population step so all three produce byte-identical card.ttl output.
 *
 * The section header rule uses U+2500 (box-drawings light horizontal); it must
 * match the init.ts card template byte-for-byte for the replacement to apply.
 */
export function applyCardIdentityName(cardTurtle: string, name: CardIdentityName): string {
  const nameFields: string[] = [];
  if (name.fullName) nameFields.push(`    foaf:name "${name.fullName}" ;`);
  if (name.givenName) nameFields.push(`    foaf:givenName "${name.givenName}" ;`);
  if (name.familyName) nameFields.push(`    foaf:familyName "${name.familyName}" ;`);
  if (nameFields.length === 0) return cardTurtle;
  return cardTurtle.replace(
    / {4}# ── Identity \(safe to make public\) ──\n( {4}#[^\n]*\n)*/,
    `    # ── Identity (safe to make public) ──\n${nameFields.join('\n')}\n`,
  );
}

/**
 * Remove any populated foaf identity triples (name / givenName / familyName)
 * that directly follow the card.ttl identity header, returning the block to a
 * pristine state so a replacement name can be applied without duplicating
 * triples. A card that still carries the commented-out placeholders is left
 * untouched (those are comments, not populated triples).
 *
 * Used by `pod profile set-name` so re-naming an already-named pod is
 * idempotent. `pod init` and import Step 9b only ever write a fresh card and do
 * not call this.
 */
export function stripCardIdentityName(cardTurtle: string): string {
  return cardTurtle.replace(
    /( {4}# ── Identity \(safe to make public\) ──\n)(?: {4}foaf:(?:name|givenName|familyName) [^\n]*\n)+/,
    '$1',
  );
}

// ─── Pod Access ──────────────────────────────────────────────────────────────

/**
 * Resolve a pod's DEK when the pod is encrypted, or `undefined` when it is not.
 *
 * A thin front for {@link openPod}, kept for the write-path commands that need
 * the key itself rather than a reader (conflict-store reads/writes, overlay
 * appends). Every failure THROWS a {@link PodUnreadableError}: a command that
 * cannot get the key must say so rather than carry on keyless, which on an
 * encrypted pod means reading ciphertext and calling the result empty.
 *
 * @throws {PodUnreadableError} when the pod is encrypted and unopenable.
 */
export async function resolvePodDekIfEncrypted(podDir: string): Promise<Buffer | undefined> {
  return (await openPod(podDir)).dek;
}

// ─── Display Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize provenance label for consistent display.
 * Converts "core:ClinicalGenerated" to "cascade:ClinicalGenerated" since
 * the "core" and "cascade" prefixes map to the same namespace.
 */
export function normalizeProvenanceLabel(label: string): string {
  if (label.startsWith('core:')) {
    return 'cascade:' + label.slice(5);
  }
  return label;
}

/**
 * Extract a display label from already-shortened property keys.
 */
export function extractLabelFromProps(properties: Record<string, string>): string | undefined {
  const labelKeys = [
    'health:medicationName',
    'health:conditionName',
    'health:allergen',
    'clinical:supplementName',
    'clinical:vaccineName',
    'health:vaccineName',
    'health:testName',
    'health:labTestName',
    'foaf:name',
    'dcterms:title',
  ];

  for (const key of labelKeys) {
    if (properties[key]) {
      return properties[key];
    }
  }
  return undefined;
}

/**
 * Select the most relevant properties for display based on data type.
 */
export function selectKeyProperties(
  typeName: string,
  properties: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  // Common properties to always show if present
  const commonKeys = ['cascade:dataProvenance', 'cascade:schemaVersion'];

  // Type-specific key properties
  const typeKeys: Record<string, string[]> = {
    medications: [
      'health:dose',
      'health:frequency',
      'health:route',
      'health:isActive',
      'health:startDate',
      'health:prescriber',
      'health:rxNormCode',
      'health:medicationClass',
    ],
    conditions: [
      'health:status',
      'health:onsetDate',
      'health:icd10Code',
      'health:snomedCode',
      'health:conditionClass',
    ],
    allergies: [
      'health:allergyCategory',
      'health:reaction',
      'health:allergySeverity',
      'health:onsetDate',
    ],
    'lab-results': [
      'health:value',
      'health:unit',
      'health:referenceRange',
      'health:interpretation',
      'health:effectiveDate',
    ],
    immunizations: [
      'health:vaccineDate',
      'health:lotNumber',
      'health:site',
      'health:manufacturer',
    ],
    supplements: [
      'clinical:dose',
      'clinical:frequency',
      'clinical:form',
      'clinical:isActive',
      'clinical:evidenceStrength',
    ],
  };

  const keysToShow = [...(typeKeys[typeName] ?? []), ...commonKeys];

  for (const key of keysToShow) {
    if (properties[key]) {
      result[key] = properties[key];
    }
  }

  // If no specific keys matched, show first few properties
  if (Object.keys(result).length === 0) {
    const allKeys = Object.keys(properties);
    for (const key of allKeys.slice(0, 5)) {
      result[key] = properties[key];
    }
  }

  return result;
}

// ─── Export Helpers ──────────────────────────────────────────────────────────

/**
 * Recursively copy a directory.
 */
export async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Create a ZIP archive of the pod directory using adm-zip.
 *
 * `extraFiles` are added alongside the pod's own contents, under the same top
 * folder. `pod export` uses it to stamp an encrypted export with the note that
 * explains why the files inside look like noise — a zip of ciphertext handed to
 * a clinician with no explanation is a brick.
 */
export async function createZipArchive(
  sourceDir: string,
  outputPath: string,
  extraFiles: Array<{ name: string; content: string }> = [],
): Promise<void> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip();
  const top = path.basename(sourceDir);
  zip.addLocalFolder(sourceDir, top);
  for (const extra of extraFiles) {
    zip.addFile(`${top}/${extra.name}`, Buffer.from(extra.content, 'utf-8'));
  }
  zip.writeZip(outputPath);
}
