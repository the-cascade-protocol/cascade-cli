/**
 * P5.1-A: Narrative block extraction for C-CDA sections.
 *
 * Extracts the <text> element from each C-CDA section and converts it to
 * plain text suitable for LLM consumption. Marks sections that have no
 * <entry> elements as requiresLLMExtraction.
 */

// Template ID → human-readable section name mapping
const TEMPLATE_ID_SECTION_NAMES: Record<string, string> = {
  '2.16.840.1.113883.10.20.22.2.1.1':  'medications',
  '2.16.840.1.113883.10.20.22.2.5.1':  'problems',
  '2.16.840.1.113883.10.20.22.2.3.1':  'labResults',
  '2.16.840.1.113883.10.20.22.2.6.1':  'allergies',
  '2.16.840.1.113883.10.20.22.2.2.1':  'immunizations',
  '2.16.840.1.113883.10.20.22.2.4.1':  'vitalSigns',
  '2.16.840.1.113883.10.20.22.2.17':   'socialHistory',
  '2.16.840.1.113883.10.20.22.2.7.1':  'procedures',
};

export interface NarrativeBlock {
  /** Human-readable section name, e.g. "medications", "problems", "socialHistory" */
  section: string;
  /** C-CDA templateId OID for this section */
  templateId: string;
  /** Plain-text content of the <section><text> element, with markup stripped */
  narrativeText: string;
  /** true when the section has no <entry> elements and requires LLM extraction */
  requiresLLMExtraction: boolean;
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

/**
 * Recursively extract plain text from a fast-xml-parser-parsed XML node.
 *
 * C-CDA <text> blocks may contain <list>, <item>, <table>, <thead>, <tbody>,
 * <tr>, <td>, <th>, <paragraph>, <content>, <renderMultiMedia>, <caption>,
 * <linkHtml>, and bare text nodes (#text in fast-xml-parser).
 *
 * Rules:
 * - Preserve newlines between list items, table rows, and paragraphs.
 * - Strip all tag names (only emit text content).
 * - Skip renderMultiMedia (no text content).
 * - Collapse runs of more than two consecutive newlines.
 */
export function extractNarrativeText(xmlNode: any): string {
  if (xmlNode === null || xmlNode === undefined) return '';

  // Primitive string / number — return as-is
  if (typeof xmlNode === 'string') return xmlNode;
  if (typeof xmlNode === 'number') return String(xmlNode);
  if (typeof xmlNode === 'boolean') return '';

  // Array — join each element with a newline separator
  if (Array.isArray(xmlNode)) {
    return xmlNode
      .map((item) => extractNarrativeText(item))
      .filter((s) => s.trim())
      .join('\n');
  }

  // Object — collect child text in document order
  const parts: string[] = [];

  for (const key of Object.keys(xmlNode)) {
    // Skip XML attribute keys (@_ prefix)
    if (key.startsWith('@_')) continue;
    // Skip renderMultiMedia — no useful text
    if (key === 'renderMultiMedia') continue;

    const value = xmlNode[key];

    if (key === '#text') {
      // Raw text node
      const text = String(value).trim();
      if (text) parts.push(text);
      continue;
    }

    // Elements that imply a line break before/after their children
    const blockElements = new Set([
      'list', 'item', 'table', 'thead', 'tbody', 'tr',
      'paragraph', 'caption',
    ]);

    if (blockElements.has(key)) {
      const inner = extractNarrativeText(value);
      if (inner.trim()) parts.push(inner);
    } else {
      // Inline elements (td, th, content, linkHtml, etc.) — treat as inline
      const inner = extractNarrativeText(value);
      if (inner.trim()) parts.push(inner);
    }
  }

  // Join block parts with newlines
  const result = parts.join('\n');

  // Collapse runs of 3+ consecutive newlines down to 2
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Section traversal
// ---------------------------------------------------------------------------

/**
 * Walk the parsed C-CDA document and collect a NarrativeBlock for every
 * section that has a recognised templateId.
 *
 * Falls back to including sections with unrecognised templateIds under the
 * name "unknown:<templateId>" so that callers can still access the text.
 */
export function collectNarrativeBlocks(parsedCDA: any): NarrativeBlock[] {
  const blocks: NarrativeBlock[] = [];

  const ccdaDoc = parsedCDA?.ClinicalDocument ?? parsedCDA;

  // Locate structuredBody
  const componentTopLevel = ccdaDoc?.component;
  const componentTopArr = Array.isArray(componentTopLevel)
    ? componentTopLevel
    : componentTopLevel ? [componentTopLevel] : [];
  const body =
    componentTopArr.find((c: any) => c?.structuredBody)?.structuredBody
    ?? ccdaDoc?.structuredBody;

  if (!body) return blocks;

  const components = body?.component ?? [];
  const componentArr = Array.isArray(components) ? components : [components];

  for (const comp of componentArr) {
    const section = comp?.section ?? comp;
    if (!section || typeof section !== 'object') continue;

    // Collect templateIds
    const templateIdRaw = Array.isArray(section?.templateId)
      ? section.templateId
      : section?.templateId ? [section.templateId] : [];
    const templateIds: string[] = templateIdRaw
      .map((t: any) => t?.['@_root'] ?? t?.root ?? '')
      .filter(Boolean);

    // Find the first known templateId (prefer known over unknown)
    const knownTemplateId = templateIds.find((id) => TEMPLATE_ID_SECTION_NAMES[id]);
    const primaryTemplateId = knownTemplateId ?? templateIds[0] ?? '';

    if (!primaryTemplateId) continue;

    const sectionName = TEMPLATE_ID_SECTION_NAMES[primaryTemplateId]
      ?? `unknown:${primaryTemplateId}`;

    // Extract narrative text
    const sectionText = section?.text ?? null;
    const narrativeText = extractNarrativeText(sectionText);

    // Determine if narrative-only (no <entry> children)
    const entries = section?.entry;
    const entryArr = Array.isArray(entries)
      ? entries
      : entries ? [entries] : [];
    const requiresLLMExtraction = entryArr.length === 0;

    // Only emit a block if there is text or the section is narrative-only with content
    if (narrativeText || requiresLLMExtraction) {
      blocks.push({
        section: sectionName,
        templateId: primaryTemplateId,
        narrativeText,
        requiresLLMExtraction,
      });
    }
  }

  return blocks;
}
