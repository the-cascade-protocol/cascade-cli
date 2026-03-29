/**
 * P5.1-B: Vendor normalization layer.
 *
 * Provides a unified interface for EHR vendor-specific quirks in C-CDA documents.
 * Builds on top of the existing vendor/detect.ts and vendor/normalize.ts modules.
 *
 * Supported vendors: Epic, Cerner, Athena.
 * Auto-detection is available via detectVendor().
 */

import { detectVendor as detectVendorInternal } from './vendor/detect.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported EHR vendor identifiers. 'auto' triggers automatic detection. */
export type Vendor = 'epic' | 'cerner' | 'athena' | 'auto';

// ---------------------------------------------------------------------------
// Epic SNOMED status code mappings (P5.1-B)
//
// In Epic C-CDA exports, condition status is often expressed as a SNOMED CT
// code rather than a plain-text displayName. These codes map to canonical
// Cascade status strings.
// ---------------------------------------------------------------------------

export const EPIC_STATUS_CODES: Record<string, 'active' | 'completed' | 'inactive' | 'unknown'> = {
  // Active / chronic problem
  '55561003': 'active',
  // No longer active
  '73425007': 'inactive',
  // Condition resolved
  '413322009': 'completed',
  // Ambiguous / unknown
  '7087005': 'unknown',
};

// ---------------------------------------------------------------------------
// VendorNormalizer interface and implementation
// ---------------------------------------------------------------------------

export interface VendorNormalizer {
  /**
   * Return a human-readable display name for a condition entry.
   *
   * Epic sometimes omits the displayName attribute on the condition <value>
   * element and embeds the name as plain text inside a <text> reference.
   * This method implements the fallback.
   */
  normalizeConditionDisplayName(entry: any, section: any): string;

  /**
   * Map a raw status code string (which may be a SNOMED code or a plain text
   * status like "active") to a canonical medication status string.
   */
  normalizeMedicationStatus(statusCode: string): 'active' | 'completed' | 'unknown';

  /**
   * Return true if the given table row node (from an Epic lab results section)
   * is a metadata/header row that should be skipped (has no numeric result value).
   */
  isLabMetadataRow(row: any): boolean;

  /**
   * Detect the originating EHR vendor from the CDA document header.
   * Returns 'epic', 'cerner', 'athena', or 'auto' when vendor is unknown.
   */
  detectVendor(cdaDocument: any): Vendor;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a VendorNormalizer tuned for the given vendor.
 * Pass 'auto' to auto-detect from the document header.
 */
export function createVendorNormalizer(vendor: Vendor = 'auto'): VendorNormalizer {
  return new DefaultVendorNormalizer(vendor);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class DefaultVendorNormalizer implements VendorNormalizer {
  private readonly _vendor: Vendor;

  constructor(vendor: Vendor) {
    this._vendor = vendor;
  }

  detectVendor(cdaDocument: any): Vendor {
    const detected = detectVendorInternal(cdaDocument);
    if (detected === 'unknown') return 'auto';
    return detected as Vendor;
  }

  normalizeConditionDisplayName(entry: any, section: any): string {
    // Try the direct path first: <value displayName="...">
    const actRaw = entry?.act;
    const act = Array.isArray(actRaw) ? actRaw[0] : (actRaw ?? entry);
    const entryRelArr = Array.isArray(act?.entryRelationship)
      ? act.entryRelationship
      : act?.entryRelationship ? [act.entryRelationship] : [];

    for (const er of entryRelArr) {
      const obsArr = Array.isArray(er?.observation) ? er.observation : er?.observation ? [er.observation] : [];
      for (const obs of obsArr) {
        const valueEl = obs?.value ?? obs?.code ?? {};
        const displayName = valueEl?.['@_displayName'] ?? valueEl?.displayName ?? '';
        if (displayName) return displayName;
      }
    }

    // Epic fallback: try the <text> element at section level if available
    if (this._vendor === 'epic' || this._vendor === 'auto') {
      const sectionText = section?.text;
      if (typeof sectionText === 'string' && sectionText.trim()) {
        // Return the first non-empty line as a best-effort display name
        const firstLine = sectionText.split('\n').find((l: string) => l.trim());
        if (firstLine) return firstLine.trim();
      }
      if (typeof sectionText === 'object' && sectionText?.['#text']) {
        return String(sectionText['#text']).trim();
      }
    }

    return '';
  }

  normalizeMedicationStatus(statusCode: string): 'active' | 'completed' | 'unknown' {
    const normalized = statusCode.trim().toLowerCase();

    // Plain-text status codes
    if (normalized === 'active') return 'active';
    if (normalized === 'completed' || normalized === 'complete') return 'completed';
    if (normalized === 'inactive' || normalized === 'stopped' || normalized === 'discontinued') return 'completed';

    // Epic SNOMED status codes
    const snomedStatus = EPIC_STATUS_CODES[statusCode.trim()];
    if (snomedStatus) {
      if (snomedStatus === 'active') return 'active';
      if (snomedStatus === 'completed' || snomedStatus === 'inactive') return 'completed';
      return 'unknown';
    }

    return 'unknown';
  }

  isLabMetadataRow(row: any): boolean {
    if (!row || typeof row !== 'object') return false;

    // A metadata/header row typically has no numeric value — all cells are
    // label strings (often bold or all-caps in the original document).
    // We detect it by checking if none of the td/th cells contain a number.
    const cells: any[] = [];

    const td = row?.td;
    if (Array.isArray(td)) cells.push(...td);
    else if (td) cells.push(td);

    const th = row?.th;
    if (Array.isArray(th)) cells.push(...th);
    else if (th) cells.push(th);

    if (cells.length === 0) return false;

    // If every cell is a string with no numeric content, treat as metadata row
    const hasNumericCell = cells.some((cell: any) => {
      const text = typeof cell === 'string'
        ? cell
        : (cell?.['#text'] ?? cell?.content ?? String(cell ?? ''));
      return /\d/.test(text);
    });

    return !hasNumericCell;
  }
}
