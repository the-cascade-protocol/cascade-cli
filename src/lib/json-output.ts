/**
 * The JSON boundary. ONE encoder, and it is a GUARANTEE rather than a
 * passthrough.
 *
 * WHAT WENT WRONG
 * ---------------
 * MEASURED on a real pod: `pod query --all --edges --json` wrote 3.7 MB to
 * stdout, exited 0, wrote nothing to stderr, and `jq` refused to parse a byte of
 * it. The same binary against a synthetic pod produced pure output, so the
 * emitter looked correct and the failure looked like the user's.
 *
 * The cause is one code unit. Turtle admits `\uXXXX` escapes, so a pod literal
 * can hold an UNPAIRED surrogate; nothing on the read path rejects it, and
 * `JSON.stringify` — well-formed since ES2019 — faithfully re-emits it as the
 * escape `\ud800`. That text round-trips through `JSON.parse` and loads in
 * Python, and jq rejects the whole document:
 *
 *     jq: parse error: Invalid \uXXXX\uXXXX surrogate pair escape
 *
 * So "it came out of JSON.stringify" is not a guarantee that the bytes are
 * readable by the tools this output is piped into. Two of three parsers
 * accepting is exactly how a corrupt 3.7 MB payload looks healthy.
 *
 * WHY REPLACE AND NOT REJECT
 * --------------------------
 * A lone surrogate has NO encoding in UTF-8. It is not a character that was
 * transported badly; it is half of one, and the other half does not exist
 * anywhere to be recovered. There is nothing to preserve, so the only honest
 * options are to fail the command or to substitute U+FFFD REPLACEMENT CHARACTER,
 * which is the substitution every UTF-8 decoder in the stack would make anyway
 * the moment these bytes were written. Failing the command would make one
 * damaged literal cost a user their entire export, and the damage is in the pod
 * either way — so: substitute, and let the record still be readable.
 *
 * WHY THE VALUE AND NOT THE TEXT
 * ------------------------------
 * Repairing the emitted TEXT means deciding, mid-string, whether a `\` begins an
 * escape or is itself escaped, and getting that wrong corrupts well-formed
 * documents. Repairing the DATA cannot make that mistake. The cost is a second
 * encode, paid only when {@link needsRepair} says the first one produced
 * something a parser can reject — so the ordinary case is one `JSON.stringify`
 * and one regex test, and its output is byte-identical to what it always was.
 *
 * WHAT IS DELIBERATELY NOT TOUCHED
 * --------------------------------
 * C0 control characters (U+0000–U+001F) are already escaped by `JSON.stringify`
 * as the escapes `\u0000` / `\n` / `\t`, which is RFC 8259 conformant and accepted
 * parser; re-encoding them would be churn. U+007F (DEL) is not a C0 control and
 * RFC 8259 does not require escaping it, so it is emitted raw, as it always was.
 * Bytes that were invalid UTF-8 on the way IN have already become U+FFFD at
 * decode time, long before this module sees them.
 */

/** Matches any surrogate code unit, paired or not. Cheap over-approximation. */
const ANY_SURROGATE = /[\uD800-\uDFFF]/;

/**
 * Matches a `\uXXXX` escape naming a surrogate code unit, ANYWHERE in the text,
 * including inside a sequence of escaped backslashes it does not actually begin.
 *
 * Over-matching is the point: this only decides whether the repair pass RUNS,
 * and the repair pass is a no-op on data that needs none. Under-matching would
 * ship the defect, so the test is written to be a strict superset of the
 * condition rather than an exact one.
 */
const ANY_SURROGATE_ESCAPE = /\\u[dD][89abAB][0-9a-fA-F]{2}/;

/**
 * Whether encoded JSON text may contain something a conforming parser rejects.
 *
 * False means the text is already RFC 8259 valid and is returned untouched.
 */
export function needsRepair(json: string): boolean {
  return ANY_SURROGATE_ESCAPE.test(json) || ANY_SURROGATE.test(json);
}

/**
 * Replace every unpaired surrogate code unit in a string with U+FFFD.
 *
 * Well-formed pairs are copied through as pairs, so astral characters (emoji,
 * rarer CJK, the whole SMP) survive intact — the repair must not cost a user
 * their real characters to fix a broken one.
 */
export function sanitizeJsonString(s: string): string {
  if (!ANY_SURROGATE.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      } else {
        out += '�';
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      out += '�';
      continue;
    }
    out += s[i];
  }
  return out;
}

/**
 * Deep-repair a JSON DATA tree: every string value and every object KEY.
 *
 * Keys matter as much as values and are the half a value-only sanitizer misses.
 * `pod query --edges` keys parts of its projection on IRIs and predicate strings
 * read straight out of the pod, so a damaged literal reaches the output as a key
 * on exactly the surface the defect was measured on.
 *
 * Intended for a tree that has already been through `JSON.parse`, so the only
 * inhabitants are string / number / boolean / null / array / plain object. Run
 * on a live object graph it would flatten anything with a `toJSON` (a Date), and
 * {@link toJsonText} is careful to encode FIRST for exactly that reason.
 */
export function sanitizeForJson(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeJsonString(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeForJson(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizeJsonString(k)] = sanitizeForJson(v);
    }
    return out;
  }
  return value;
}

/**
 * THE DOOR every JSON-emitting surface goes through: encode `value` as text that
 * is RFC 8259 valid and well-formed UTF-8.
 *
 * Byte-identical to `JSON.stringify(value, null, indent)` whenever that output
 * was already valid, which is the overwhelmingly common case.
 *
 * Returns the empty string for input `JSON.stringify` declines to encode at all
 * (`undefined`, a function, a symbol), rather than the literal text "undefined",
 * which is not JSON and is what a `--json` consumer would otherwise be handed.
 */
export function toJsonText(value: unknown, indent: number = 2): string {
  const first = JSON.stringify(value, null, indent);
  if (first === undefined) return '';
  if (!needsRepair(first)) return first;
  return JSON.stringify(sanitizeForJson(JSON.parse(first)), null, indent);
}
