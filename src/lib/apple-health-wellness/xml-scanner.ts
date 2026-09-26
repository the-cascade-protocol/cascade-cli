/**
 * A streaming, bounded-memory element scanner for Apple Health's `export.xml`.
 *
 * WHY NOT A GENERAL XML PARSER. A real export is 4.6 GB, over Node's whole-file
 * read limit, so it has to be read as a stream; the only parser already in this
 * repo (fast-xml-parser) wants the whole document. What the aggregator needs
 * from the file is small and regular: element names, their attributes, and
 * which element each one is nested in. This scanner produces exactly that, one
 * event per start tag and end tag, from a stream of text chunks, holding at most
 * one unfinished tag plus one chunk in memory.
 *
 * WHAT IT HANDLES, because the file contains it:
 *   - the XML declaration and processing instructions (`<?...?>`);
 *   - the DOCTYPE with its internal DTD subset, whose `<!ELEMENT ...>` and
 *     `<!ATTLIST ...>` declarations contain `>` characters that must not end
 *     the DOCTYPE, and whose comments are skipped as comments;
 *   - comments and CDATA sections (skipped);
 *   - attribute values in either quote style, which may contain `>` (a quoted
 *     `>` never ends a tag), and the five predefined entities plus numeric
 *     character references, decoded;
 *   - text content, which the export does not use and which is skipped.
 *
 * It is not a validating parser and does not check well-formedness beyond what
 * it needs to find tag boundaries. A truncated file ends the scan at the last
 * complete tag; the caller learns that from the missing close events.
 */

import fs from 'node:fs';

export interface XmlOpenEvent {
  kind: 'open';
  name: string;
  attrs: Record<string, string>;
  /** `<Name ... />`: no close event follows. */
  selfClosing: boolean;
}

export interface XmlCloseEvent {
  kind: 'close';
  name: string;
}

export type XmlEvent = XmlOpenEvent | XmlCloseEvent;

const ENTITY_RE = /&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g;

/** Decode the predefined XML entities and numeric character references in an attribute value. */
export function decodeXmlText(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(ENTITY_RE, (_m, ent: string) => {
    switch (ent) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const cp = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : _m;
      }
    }
  });
}

const ATTR_RE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseTag(inner: string): XmlOpenEvent {
  let body = inner;
  let selfClosing = false;
  if (body.endsWith('/')) {
    selfClosing = true;
    body = body.slice(0, -1);
  }
  const nameMatch = /^[^\s/>]+/.exec(body);
  const name = nameMatch ? nameMatch[0] : '';
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = name.length;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(body)) !== null) {
    attrs[m[1]] = decodeXmlText(m[2] ?? m[3] ?? '');
  }
  return { kind: 'open', name, attrs, selfClosing };
}

/** Index of the `>` that ends the tag starting at `from`, skipping quoted `>`; -1 if not yet in the buffer. */
function tagEnd(buf: string, from: number): number {
  let quote = '';
  for (let i = from; i < buf.length; i++) {
    const c = buf.charCodeAt(i);
    if (quote) {
      if (c === quote.charCodeAt(0)) quote = '';
    } else if (c === 34 /* " */ || c === 39 /* ' */) {
      quote = buf[i];
    } else if (c === 62 /* > */) {
      return i;
    }
  }
  return -1;
}

/** Index just past the `>` ending a `<!DOCTYPE ... [ ... ]>`; -1 if not yet in the buffer. */
function doctypeEnd(buf: string, from: number): number {
  let depth = 0;
  let quote = '';
  for (let i = from; i < buf.length; i++) {
    const c = buf[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '<' && buf.startsWith('<!--', i)) {
      const end = buf.indexOf('-->', i + 4);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) return i + 1;
  }
  return -1;
}

/**
 * Scan a stream of text chunks, calling `onEvent` once per start and end tag,
 * in document order. Synchronous per event (a callback, not an async iterator)
 * because a real export holds tens of millions of tags.
 */
export async function scanXml(chunks: AsyncIterable<string>, onEvent: (e: XmlEvent) => void): Promise<void> {
  const it = chunks[Symbol.asyncIterator]();
  let buf = '';
  let pos = 0;
  let eof = false;

  const more = async (): Promise<boolean> => {
    if (eof) return false;
    const r = await it.next();
    if (r.done) {
      eof = true;
      return false;
    }
    if (pos > 0) {
      buf = buf.slice(pos);
      pos = 0;
    }
    buf += r.value;
    return true;
  };

  for (;;) {
    const lt = buf.indexOf('<', pos);
    if (lt === -1) {
      pos = buf.length;
      if (!(await more())) return;
      continue;
    }
    pos = lt;
    // Enough characters to classify the construct.
    if (buf.length - pos < 9 && !eof) {
      await more();
      continue;
    }
    let consumed = -1;
    if (buf.startsWith('<?', pos)) {
      const end = buf.indexOf('?>', pos + 2);
      if (end !== -1) consumed = end + 2;
    } else if (buf.startsWith('<!--', pos)) {
      const end = buf.indexOf('-->', pos + 4);
      if (end !== -1) consumed = end + 3;
    } else if (buf.startsWith('<![CDATA[', pos)) {
      const end = buf.indexOf(']]>', pos + 9);
      if (end !== -1) consumed = end + 3;
    } else if (buf.startsWith('<!', pos)) {
      consumed = doctypeEnd(buf, pos + 2);
    } else if (buf.startsWith('</', pos)) {
      const end = buf.indexOf('>', pos + 2);
      if (end !== -1) {
        onEvent({ kind: 'close', name: buf.slice(pos + 2, end).trim() });
        consumed = end + 1;
      }
    } else {
      const end = tagEnd(buf, pos + 1);
      if (end !== -1) {
        const open = parseTag(buf.slice(pos + 1, end).trim());
        onEvent(open);
        if (open.selfClosing) onEvent({ kind: 'close', name: open.name });
        consumed = end + 1;
      }
    }
    if (consumed === -1) {
      // The construct is not complete in the buffer yet.
      if (!(await more())) return;
      continue;
    }
    pos = consumed;
  }
}

/** A UTF-8 text stream over a file, in 1 MiB chunks. Never reads the file whole. */
export function fileTextChunks(filePath: string): AsyncIterable<string> {
  return fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 });
}

/** A text stream over an in-memory string, in chunks of `size` (tests exercise chunk boundaries with it). */
export async function* stringChunks(text: string, size = 7): AsyncIterable<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

/**
 * A copy of `s` that shares no memory with the text it was cut from.
 *
 * V8 represents `buf.slice(a, b)` (and a regex capture) as a view onto the
 * parent string, so one short attribute value kept past its tag pins the whole
 * buffer it came from: a megabyte or more of export text. Every string the
 * scan KEEPS (a workout, an ActivitySummary, a series key, a time zone name)
 * goes through this, or the retained attributes of a real export pin hundreds
 * of megabytes of text that has long been scanned.
 */
export function detach(s: string): string {
  return Buffer.from(s, 'utf8').toString('utf8');
}

/** {@link detach} over an attribute map, keys and values. */
export function detachAll(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(attrs)) out[detach(k)] = detach(attrs[k]);
  return out;
}
