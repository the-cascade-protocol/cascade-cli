/**
 * Apply vendor-specific normalization shims to a parsed C-CDA document.
 */

import type { EhrVendor } from './detect.js';
import { normalizeEpic } from './quirks/epic.js';
import { normalizeCerner } from './quirks/cerner.js';

export function applyVendorNormalization(doc: any, vendor: EhrVendor): any {
  switch (vendor) {
    case 'epic':   return normalizeEpic(doc);
    case 'cerner': return normalizeCerner(doc);
    default:       return JSON.parse(JSON.stringify(doc));  // safe clone, no special normalization
  }
}
