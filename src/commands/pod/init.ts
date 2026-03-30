/**
 * cascade pod init <directory>
 *
 * Initialize a new Cascade Pod with the standard directory structure,
 * template files, and discovery documents.
 */

import type { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { printResult, printError, printVerbose, type OutputOptions } from '../../lib/output.js';
import { resolvePodDir, fileExists } from './helpers.js';

// ─── Pod Init Templates ──────────────────────────────────────────────────────

function wellKnownSolid(absPath: string): string {
  return JSON.stringify(
    {
      '@context': 'https://www.w3.org/ns/solid/terms',
      pod_root: '/',
      profile: '/profile/card.ttl#me',
      storage: '/',
      preferencesFile: '/settings/preferences',
      publicTypeIndex: '/settings/publicTypeIndex.ttl',
      privateTypeIndex: '/settings/privateTypeIndex.ttl',
      podUri: `file://${absPath}/`,
      version: '1.0',
    },
    null,
    2,
  );
}

const PROFILE_CARD_TTL = `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix pim: <http://www.w3.org/ns/pim/space#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .

# =============================================================================
# WebID Profile Card  (public)
# =============================================================================
# This document is publicly readable per Solid conventions.
# Keep it to identity and discovery links only — no PHI.
# PHI (DOB, address, phone, email) belongs in profile/extended.ttl (private).
# =============================================================================

</profile/card.ttl> a foaf:PersonalProfileDocument ;
    foaf:primaryTopic <#me> .

<#me> a foaf:Person ;
    # ── Identity (safe to make public) ──
    # foaf:name "First Last" ;
    # foaf:givenName "First" ;
    # foaf:familyName "Last" ;

    # ── Discovery links (do not remove) ──
    pim:storage </> ;
    pim:preferencesFile </settings/preferences> ;
    solid:publicTypeIndex </settings/publicTypeIndex.ttl> ;
    rdfs:seeAlso </profile/extended.ttl> ;

    cascade:schemaVersion "1.3" .
`;

const PUBLIC_TYPE_INDEX_TTL = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .

# =============================================================================
# Public Type Index
# =============================================================================
# Maps data types to their storage locations in the Pod.
# Public registrations are visible to authorized applications.
#
# As you populate your Pod with data, add type registrations here so that
# agents and applications can discover where to find each data type.
# =============================================================================

<> a solid:TypeIndex, solid:ListedDocument .

# Type registrations will be added as data is populated.
# Example:
# <#medications> a solid:TypeRegistration ;
#     solid:forClass health:MedicationRecord ;
#     solid:instance </clinical/medications.ttl> .
#
# <#conditions> a solid:TypeRegistration ;
#     solid:forClass health:ConditionRecord ;
#     solid:instance </clinical/conditions.ttl> .
`;

const PRIVATE_TYPE_INDEX_TTL = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .

# =============================================================================
# Private Type Index
# =============================================================================
# Maps wellness and device data types to their storage locations.
# Private registrations require explicit authorization to access.
#
# Wellness data (heart rate, activity, sleep, etc.) is typically registered
# here rather than in the public type index.
# =============================================================================

<> a solid:TypeIndex, solid:UnlistedDocument .

# Type registrations will be added as wellness data is populated.
# Example:
# <#heartRate> a solid:TypeRegistration ;
#     solid:forClass health:HeartRateData ;
#     solid:instance </wellness/heart-rate.ttl> .
`;

const PREFERENCES_TTL = `@prefix pim: <http://www.w3.org/ns/pim/space#> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

# =============================================================================
# Private Preferences  (owner-only)
# =============================================================================
# This file is the root of all private configuration for this Pod.
# It holds the pointer to the private type index and may link to
# further private extended profiles via rdfs:seeAlso.
# =============================================================================

<> a pim:ConfigurationFile .

<#me>
    solid:privateTypeIndex </settings/privateTypeIndex.ttl> ;
    rdfs:seeAlso </profile/extended.ttl> .
`;

const EXTENDED_PROFILE_TTL = `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix vcard: <http://www.w3.org/2006/vcard/ns#> .
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

# =============================================================================
# Extended Profile  (private, owner-only)
# =============================================================================
# This document holds PHI and private contact information.
# It must NOT be publicly accessible — apply an owner-only ACL.
# Linked from profile/card.ttl via rdfs:seeAlso and from
# settings/preferences via rdfs:seeAlso.
# =============================================================================

<#me>
    # ── Demographics ──
    # cascade:dateOfBirth "1990-01-01"^^xsd:date ;
    # cascade:biologicalSex "M" ;

    # ── Contact ──
    # vcard:hasTelephone "+1-555-000-0000" ;
    # vcard:hasEmail "user@example.com" ;

    # ── Address ──
    # cascade:address [
    #     cascade:addressLine "123 Main St" ;
    #     cascade:addressCity "Seattle" ;
    #     cascade:addressState "WA" ;
    #     cascade:addressPostalCode "98101" ;
    #     cascade:addressCountry "US" ;
    # ] ;
    .
`;

function indexTtl(dirName: string): string {
  const now = new Date().toISOString();
  return `@prefix ldp: <http://www.w3.org/ns/ldp#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

# =============================================================================
# Root LDP Container
# =============================================================================
# This is the root index of this Cascade Pod, structured as an LDP Basic
# Container per Solid Protocol conventions. It enumerates every resource
# in the Pod for discoverability by agents and applications.
#
# Update this file as you add or remove resources.
# =============================================================================

<> a ldp:BasicContainer ;
    dcterms:title "${dirName} -- Cascade Pod" ;
    dcterms:description "A Cascade Protocol Pod initialized with the cascade CLI." ;
    dcterms:created "${now}"^^xsd:dateTime ;
    cascade:schemaVersion "1.3" ;

    # ── Profile & Settings ──
    ldp:contains
        <profile/card.ttl> ,
        <profile/extended.ttl> ,
        <settings/preferences> ,
        <settings/publicTypeIndex.ttl> ,
        <settings/privateTypeIndex.ttl> .

    # ── Add clinical and wellness resources below as they are created ──
    # ldp:contains <clinical/medications.ttl> .
    # ldp:contains <wellness/heart-rate.ttl> .
`;
}

const README_MD = `# Cascade Protocol Pod

This directory is a **Cascade Protocol Pod** -- a portable, self-describing collection of personal health data serialized as RDF/Turtle files.

## Structure

\`\`\`
.well-known/
  solid                    # Pod discovery document (JSON)
profile/
  card.ttl                 # WebID profile (public — identity + discovery links only)
  extended.ttl             # Extended profile (private — PHI: DOB, address, phone, email)
settings/
  preferences              # Private preferences (owner-only — links to privateTypeIndex)
  publicTypeIndex.ttl      # Maps clinical data types to file locations
  privateTypeIndex.ttl     # Maps wellness data types to file locations
clinical/                  # Clinical records (EHR-sourced data)
wellness/                  # Wellness records (device and self-reported data)
index.ttl                  # Root LDP container listing all resources
\`\`\`

## Getting Started

1. Edit \`profile/card.ttl\` to set the Pod owner's display name (public-safe).
2. Edit \`profile/extended.ttl\` to fill in PHI (DOB, address, phone, email) — keep this private.
3. Add clinical data files (e.g., \`clinical/medications.ttl\`) and register them in \`settings/publicTypeIndex.ttl\`.
4. Add wellness data files (e.g., \`wellness/heart-rate.ttl\`) and register them in \`settings/privateTypeIndex.ttl\`.
5. Update \`index.ttl\` to list all resources.

## Useful Commands

\`\`\`bash
cascade pod info .           # Show Pod summary
cascade pod query . --all    # Query all data in the Pod
cascade pod export . --format zip   # Export as ZIP archive
cascade validate .           # Validate against SHACL shapes
\`\`\`

## Learn More

- Cascade Protocol: https://cascadeprotocol.org
- Pod Structure Spec: https://cascadeprotocol.org/docs/spec/pod-structure
- Cascade SDK: https://github.com/nickthorpe71/cascade-sdk-swift
`;

// ─── Command Registration ────────────────────────────────────────────────────

export function registerInitSubcommand(pod: Command, program: Command): void {
  pod
    .command('init')
    .description('Initialize a new Cascade Pod')
    .argument('<directory>', 'Directory to initialize as a Cascade Pod')
    .action(async (directory: string) => {
      const globalOpts = program.opts() as OutputOptions;
      const absDir = resolvePodDir(directory);
      const dirName = path.basename(absDir);

      printVerbose(`Initializing pod at: ${absDir}`, globalOpts);

      try {
        // Check if directory already has pod structure
        if (await fileExists(path.join(absDir, 'index.ttl'))) {
          printError(`Directory already contains a Cascade Pod: ${absDir}`, globalOpts);
          process.exitCode = 1;
          return;
        }

        // Create directory structure
        const dirs = [
          path.join(absDir, '.well-known'),
          path.join(absDir, 'profile'),
          path.join(absDir, 'settings'),
          path.join(absDir, 'clinical'),
          path.join(absDir, 'wellness'),
        ];

        for (const dir of dirs) {
          await fs.mkdir(dir, { recursive: true });
        }

        // Write template files
        await fs.writeFile(path.join(absDir, '.well-known', 'solid'), wellKnownSolid(absDir));
        await fs.writeFile(path.join(absDir, 'profile', 'card.ttl'), PROFILE_CARD_TTL);
        await fs.writeFile(path.join(absDir, 'profile', 'extended.ttl'), EXTENDED_PROFILE_TTL);
        await fs.writeFile(path.join(absDir, 'settings', 'preferences'), PREFERENCES_TTL);
        await fs.writeFile(path.join(absDir, 'settings', 'publicTypeIndex.ttl'), PUBLIC_TYPE_INDEX_TTL);
        await fs.writeFile(path.join(absDir, 'settings', 'privateTypeIndex.ttl'), PRIVATE_TYPE_INDEX_TTL);
        await fs.writeFile(path.join(absDir, 'index.ttl'), indexTtl(dirName));
        await fs.writeFile(path.join(absDir, 'README.md'), README_MD);

        const filesCreated = [
          '.well-known/solid',
          'profile/card.ttl',
          'profile/extended.ttl',
          'settings/preferences',
          'settings/publicTypeIndex.ttl',
          'settings/privateTypeIndex.ttl',
          'clinical/',
          'wellness/',
          'index.ttl',
          'README.md',
        ];

        if (globalOpts.json) {
          printResult(
            {
              status: 'created',
              directory: absDir,
              files: filesCreated,
              message: 'Cascade Pod initialized successfully.',
            },
            globalOpts,
          );
        } else {
          console.log(`Cascade Pod initialized at: ${absDir}\n`);
          console.log('Created:');
          for (const f of filesCreated) {
            console.log(`  ${f}`);
          }
          console.log('\nNext steps:');
          console.log('  1. Edit profile/card.ttl to set patient name and demographics');
          console.log('  2. Add data files to clinical/ and wellness/ directories');
          console.log('  3. Register data types in settings/publicTypeIndex.ttl');
          console.log(`  4. Run: cascade pod info ${directory}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        printError(`Failed to initialize pod: ${message}`, globalOpts);
        process.exitCode = 1;
      }
    });
}
