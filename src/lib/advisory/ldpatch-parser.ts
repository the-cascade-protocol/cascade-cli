/**
 * Cascade Advisory Patch (CAP) — LDPatch parser.
 *
 * TASK-4.1: Hand-rolled tokenizer + recursive-descent parser for the strict
 * CAP profile of W3C LDPatch. We deliberately do NOT support the full LDPatch
 * grammar — out-of-profile constructs (`Delete`, `Cut`, `UpdateList`, multiple
 * `Bind`s, complex Bind path expressions) cause an immediate, well-located
 * "out of CAP profile" error.
 *
 * Why hand-rolled? The published LDPatch grammar is small enough to be
 * straightforward, but more importantly we need precise line/column info on
 * every AST node and every error so the validator (TASK-4.2) and the
 * dry-run reporter can surface human-friendly diagnostics. n3.js doesn't
 * preserve column info on its AST, and there is no maintained LDPatch parser
 * in the npm ecosystem.
 *
 * Grammar accepted (informal):
 *
 *   capDocument  ::= prefixDecl* envelopeBlock? bindClause? addClause+
 *   prefixDecl   ::= '@prefix' PNAME_NS IRIREF '.'
 *   envelopeBlock::= '<>' predicateObjectList '.'
 *   bindClause   ::= 'Bind' VAR IRIREF? VAR predicate literal '.'
 *   addClause    ::= 'Add' '{' triples '}' '.'
 *
 *   triples      ::= subject predicateObjectList ('.' subject predicateObjectList)*
 *   predicateObjectList ::= predicate objectList (';' predicate objectList)*
 *   objectList   ::= object (',' object)*
 *   subject      ::= IRIREF | PNAME_LN | VAR
 *   predicate    ::= IRIREF | PNAME_LN | 'a'
 *   object       ::= IRIREF | PNAME_LN | VAR | literal | 'true' | 'false'
 *   literal      ::= STRING ('^^' (IRIREF|PNAME_LN) | '@' LANGTAG)?
 *
 * Anything resembling 'Delete', 'D' (LDPatch shorthand), 'Cut', 'C',
 * 'UpdateList', 'UL' yields an out-of-profile error.
 */

import type {
  CapAdd,
  CapAst,
  CapBind,
  CapEnvelope,
  CapParseError,
  CapPosition,
  CapTerm,
  CapTriple,
} from './types.js';
import { ADVISORY_NS } from './types.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Public API                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

export interface CapParseResult {
  ast: CapAst | null;
  errors: CapParseError[];
}

/**
 * Parse a CAP `.ldpatch` source string.
 *
 * On success, `ast` is populated and `errors` is empty.
 * On failure, `ast` is null and `errors` contains at least one diagnostic.
 *
 * The parser is fast-fail: out-of-profile constructs short-circuit further
 * parsing rather than attempting partial recovery, which matches the
 * "any LDPatch syntax error → reject" rule in PROFILE.md §Profile validation.
 */
export function parseCap(input: string): CapParseResult {
  const tokenizer = new Tokenizer(input);
  const tokens = tokenizer.tokenize();
  if (tokenizer.errors.length > 0) {
    return { ast: null, errors: tokenizer.errors };
  }
  const parser = new Parser(tokens);
  return parser.parseDocument();
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Tokenizer                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

type TokenKind =
  | 'IRIREF' // <http://...>
  | 'PNAME_LN' // prefix:local
  | 'PNAME_NS' // prefix: (no local part — only legal as @prefix subject)
  | 'STRING' // "..." or """..."""
  | 'VAR' // ?name
  | 'BNODE' // _:name
  | 'NUMBER'
  | 'BOOL' // true | false
  | 'A' // 'a' (rdf:type shorthand)
  | 'KW_PREFIX' // @prefix
  | 'KW_BASE' // @base (illegal in CAP, but we tokenize to give a clear error)
  | 'KW_ADD' // Add or A — but 'A' alone is ambiguous with rdf:type; we use 'Add' only
  | 'KW_BIND' // Bind or B
  | 'KW_DELETE' // Delete or D — REJECTED (out of profile)
  | 'KW_CUT' // Cut or C — REJECTED
  | 'KW_UPDATELIST' // UpdateList or UL — REJECTED
  | 'LBRACE'
  | 'RBRACE'
  | 'LBRACKET'
  | 'RBRACKET'
  | 'LPAREN'
  | 'RPAREN'
  | 'DOT'
  | 'SEMI'
  | 'COMMA'
  | 'CARET2' // ^^
  | 'AT' // @ (lang tag prefix)
  | 'LANGTAG'
  | 'EOF';

interface Token {
  kind: TokenKind;
  value: string;
  pos: CapPosition;
}

class Tokenizer {
  private pos = 0;
  private line = 1;
  private col = 1;
  public errors: CapParseError[] = [];

  constructor(private readonly input: string) {}

  tokenize(): Token[] {
    const out: Token[] = [];
    while (this.pos < this.input.length) {
      this.skipWhitespaceAndComments();
      if (this.pos >= this.input.length) break;
      const start: CapPosition = { line: this.line, col: this.col };
      const tok = this.nextToken(start);
      if (tok) out.push(tok);
      if (this.errors.length > 0) return out;
    }
    out.push({ kind: 'EOF', value: '', pos: { line: this.line, col: this.col } });
    return out;
  }

  private nextToken(start: CapPosition): Token | null {
    const ch = this.input[this.pos];

    // Comments — handled in skipWhitespaceAndComments, but defensively:
    if (ch === '#') {
      this.skipLine();
      return null;
    }

    // Punctuation
    switch (ch) {
      case '.':
        this.advance();
        return { kind: 'DOT', value: '.', pos: start };
      case ';':
        this.advance();
        return { kind: 'SEMI', value: ';', pos: start };
      case ',':
        this.advance();
        return { kind: 'COMMA', value: ',', pos: start };
      case '{':
        this.advance();
        return { kind: 'LBRACE', value: '{', pos: start };
      case '}':
        this.advance();
        return { kind: 'RBRACE', value: '}', pos: start };
      case '[':
        this.advance();
        return { kind: 'LBRACKET', value: '[', pos: start };
      case ']':
        this.advance();
        return { kind: 'RBRACKET', value: ']', pos: start };
      case '(':
        this.advance();
        return { kind: 'LPAREN', value: '(', pos: start };
      case ')':
        this.advance();
        return { kind: 'RPAREN', value: ')', pos: start };
    }

    // ^^ (datatype tag)
    if (ch === '^' && this.input[this.pos + 1] === '^') {
      this.advance();
      this.advance();
      return { kind: 'CARET2', value: '^^', pos: start };
    }

    // Strings — "..." or """..."""
    if (ch === '"') {
      return this.readString(start);
    }

    // IRIREF — <...>
    if (ch === '<') {
      return this.readIriref(start);
    }

    // ?var
    if (ch === '?') {
      return this.readVar(start);
    }

    // _:bnode
    if (ch === '_' && this.input[this.pos + 1] === ':') {
      return this.readBnode(start);
    }

    // @prefix, @base, @langtag
    if (ch === '@') {
      return this.readAt(start);
    }

    // Number (positive or negative)
    if (ch === '-' || ch === '+' || (ch >= '0' && ch <= '9')) {
      return this.readNumber(start);
    }

    // Identifier / keyword / PNAME / 'a'
    if (isPNCharsBase(ch) || ch === '_') {
      return this.readNameOrKeyword(start);
    }

    this.error(start, `Unexpected character '${ch}'`, 'syntax');
    this.advance();
    return null;
  }

  private readString(start: CapPosition): Token {
    // Triple-quoted?
    if (this.input.startsWith('"""', this.pos)) {
      this.advance();
      this.advance();
      this.advance();
      let s = '';
      while (this.pos < this.input.length && !this.input.startsWith('"""', this.pos)) {
        if (this.input[this.pos] === '\\') {
          s += this.readEscape();
        } else {
          s += this.input[this.pos];
          this.advance();
        }
      }
      if (this.pos >= this.input.length) {
        this.error(start, 'Unterminated triple-quoted string', 'syntax');
        return { kind: 'STRING', value: s, pos: start };
      }
      this.advance();
      this.advance();
      this.advance();
      return { kind: 'STRING', value: s, pos: start };
    }

    // Single-quoted
    this.advance(); // opening "
    let s = '';
    while (this.pos < this.input.length && this.input[this.pos] !== '"') {
      if (this.input[this.pos] === '\\') {
        s += this.readEscape();
      } else if (this.input[this.pos] === '\n') {
        this.error(start, 'Unterminated string literal (newline before closing quote)', 'syntax');
        return { kind: 'STRING', value: s, pos: start };
      } else {
        s += this.input[this.pos];
        this.advance();
      }
    }
    if (this.pos >= this.input.length) {
      this.error(start, 'Unterminated string literal', 'syntax');
      return { kind: 'STRING', value: s, pos: start };
    }
    this.advance(); // closing "
    return { kind: 'STRING', value: s, pos: start };
  }

  private readEscape(): string {
    this.advance(); // backslash
    const ch = this.input[this.pos];
    this.advance();
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case "'":
        return "'";
      case '\\':
        return '\\';
      default:
        // Permissive: pass through unknown escapes literally
        return ch ?? '';
    }
  }

  private readIriref(start: CapPosition): Token {
    this.advance(); // opening <
    let s = '';
    while (this.pos < this.input.length && this.input[this.pos] !== '>') {
      if (this.input[this.pos] === '\n') {
        this.error(start, 'Unterminated IRI (newline before closing >)', 'syntax');
        return { kind: 'IRIREF', value: s, pos: start };
      }
      s += this.input[this.pos];
      this.advance();
    }
    if (this.pos >= this.input.length) {
      this.error(start, 'Unterminated IRI', 'syntax');
      return { kind: 'IRIREF', value: s, pos: start };
    }
    this.advance(); // closing >
    return { kind: 'IRIREF', value: s, pos: start };
  }

  private readVar(start: CapPosition): Token {
    this.advance(); // ?
    let s = '';
    while (this.pos < this.input.length && isPNChars(this.input[this.pos]!)) {
      s += this.input[this.pos];
      this.advance();
    }
    if (s.length === 0) {
      this.error(start, "Variable name expected after '?'", 'syntax');
    }
    return { kind: 'VAR', value: s, pos: start };
  }

  private readBnode(start: CapPosition): Token {
    this.advance(); // _
    this.advance(); // :
    let s = '';
    while (this.pos < this.input.length && isPNChars(this.input[this.pos]!)) {
      s += this.input[this.pos];
      this.advance();
    }
    return { kind: 'BNODE', value: s, pos: start };
  }

  private readAt(start: CapPosition): Token {
    this.advance(); // @
    let s = '';
    while (this.pos < this.input.length && /[A-Za-z0-9-]/.test(this.input[this.pos]!)) {
      s += this.input[this.pos];
      this.advance();
    }
    if (s === 'prefix') return { kind: 'KW_PREFIX', value: '@prefix', pos: start };
    if (s === 'base') return { kind: 'KW_BASE', value: '@base', pos: start };
    if (s.length === 0) {
      this.error(start, "Identifier expected after '@'", 'syntax');
      return { kind: 'AT', value: '@', pos: start };
    }
    // Lang tag (e.g., @en, @en-US)
    return { kind: 'LANGTAG', value: s, pos: start };
  }

  private readNumber(start: CapPosition): Token {
    let s = '';
    if (this.input[this.pos] === '-' || this.input[this.pos] === '+') {
      s += this.input[this.pos];
      this.advance();
    }
    while (this.pos < this.input.length && /[0-9.eE+\-]/.test(this.input[this.pos]!)) {
      s += this.input[this.pos];
      this.advance();
    }
    return { kind: 'NUMBER', value: s, pos: start };
  }

  private readNameOrKeyword(start: CapPosition): Token {
    // Read up to first non-pname-char, but stop at ':' (which begins a PNAME local part).
    let local = '';
    while (this.pos < this.input.length && isPNChars(this.input[this.pos]!)) {
      local += this.input[this.pos];
      this.advance();
    }

    // PNAME case: prefix ':' [local]
    if (this.input[this.pos] === ':') {
      this.advance(); // ':'
      let after = '';
      while (
        this.pos < this.input.length &&
        (isPNChars(this.input[this.pos]!) || this.input[this.pos] === '.')
      ) {
        // We're a bit permissive on trailing '.': in Turtle, '.' is allowed inside
        // a local name but not at the end. We'll just slurp and trim later.
        after += this.input[this.pos];
        this.advance();
      }
      // Trim trailing '.' that should be a punctuation token instead.
      while (after.endsWith('.')) {
        after = after.slice(0, -1);
        this.pos -= 1;
        this.col -= 1;
      }
      if (after.length === 0) {
        return { kind: 'PNAME_NS', value: local, pos: start };
      }
      return { kind: 'PNAME_LN', value: `${local}:${after}`, pos: start };
    }

    // Standalone keyword/literal.
    switch (local) {
      case 'a':
        return { kind: 'A', value: 'a', pos: start };
      case 'true':
      case 'false':
        return { kind: 'BOOL', value: local, pos: start };
      case 'Add':
      case 'A':
        // Ambiguous: 'A' alone is also rdf:type shorthand. LDPatch shorthand
        // for Add is 'A'. We disambiguate by context in the parser, BUT since
        // 'a' (lowercase) is the rdf:type shorthand and 'A' (uppercase) is the
        // LDPatch Add shorthand, we treat uppercase A as KW_ADD safely.
        return local === 'Add'
          ? { kind: 'KW_ADD', value: 'Add', pos: start }
          : { kind: 'KW_ADD', value: 'A', pos: start };
      case 'Bind':
      case 'B':
        return { kind: 'KW_BIND', value: local, pos: start };
      case 'Delete':
      case 'D':
        return { kind: 'KW_DELETE', value: local, pos: start };
      case 'Cut':
        return { kind: 'KW_CUT', value: local, pos: start };
      case 'C':
        // 'C' is LDPatch shorthand for Cut.
        return { kind: 'KW_CUT', value: 'C', pos: start };
      case 'UpdateList':
      case 'UL':
        return { kind: 'KW_UPDATELIST', value: local, pos: start };
      default:
        // Bare names without a prefix are out-of-profile in Turtle/LDPatch.
        this.error(
          start,
          `Unexpected bare name '${local}' (expected prefix:local, IRIREF, or keyword)`,
          'syntax',
        );
        return { kind: 'A', value: local, pos: start }; // unreachable; error short-circuits
    }
  }

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos]!;
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.advance();
      } else if (ch === '\n') {
        this.advance();
      } else if (ch === '#') {
        this.skipLine();
      } else {
        return;
      }
    }
  }

  private skipLine(): void {
    while (this.pos < this.input.length && this.input[this.pos] !== '\n') {
      this.advance();
    }
  }

  private advance(): void {
    if (this.input[this.pos] === '\n') {
      this.line += 1;
      this.col = 1;
    } else {
      this.col += 1;
    }
    this.pos += 1;
  }

  private error(pos: CapPosition, message: string, code: CapParseError['code']): void {
    this.errors.push({ ...pos, message, code });
  }
}

function isPNCharsBase(ch: string): boolean {
  return /[A-Za-zÀ-ÖØ-öø-˿Ͱ-ͽͿ-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�]/.test(
    ch,
  );
}

function isPNChars(ch: string): boolean {
  return isPNCharsBase(ch) || /[0-9_\-·̀-ͯ‿-⁀]/.test(ch);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Parser                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

class Parser {
  private idx = 0;
  private prefixes: Record<string, string> = {};
  private errors: CapParseError[] = [];

  constructor(private readonly tokens: Token[]) {}

  parseDocument(): CapParseResult {
    let envelope: CapEnvelope | null = null;
    let bind: CapBind | null = null;
    const adds: CapAdd[] = [];

    // 1) prefix declarations (zero or more)
    while (this.peek().kind === 'KW_PREFIX') {
      this.parsePrefixDecl();
      if (this.errors.length > 0) return { ast: null, errors: this.errors };
    }

    // C3 enforcement note: any LATER @prefix is rejected by this loop ending here;
    // we'll detect a stray @prefix below as out-of-profile.
    if (this.peek().kind === 'KW_BASE') {
      const t = this.peek();
      this.error(t.pos, "@base directive is not allowed in CAP profile (C3)", 'out_of_profile');
      return { ast: null, errors: this.errors };
    }

    // 2) optional envelope (bare Turtle on `<>`)
    if (this.isEnvelopeStart()) {
      envelope = this.parseEnvelope();
      if (this.errors.length > 0) return { ast: null, errors: this.errors };
    }

    // 3) optional Bind
    if (this.peek().kind === 'KW_BIND') {
      bind = this.parseBind();
      if (this.errors.length > 0) return { ast: null, errors: this.errors };
    }

    // 4) one or more Adds — and detection of out-of-profile keywords
    while (this.peek().kind !== 'EOF') {
      const t = this.peek();
      if (t.kind === 'KW_PREFIX') {
        this.error(
          t.pos,
          '@prefix declarations must appear before any operation (C3: no prefix manipulation)',
          'out_of_profile',
        );
        return { ast: null, errors: this.errors };
      }
      if (t.kind === 'KW_DELETE') {
        this.error(
          t.pos,
          `'${t.value}' (Delete) is out of CAP profile — only 'Add' may produce triples (C1)`,
          'out_of_profile',
        );
        return { ast: null, errors: this.errors };
      }
      if (t.kind === 'KW_CUT') {
        this.error(
          t.pos,
          `'${t.value}' (Cut) is out of CAP profile — only 'Add' may produce triples (C1)`,
          'out_of_profile',
        );
        return { ast: null, errors: this.errors };
      }
      if (t.kind === 'KW_UPDATELIST') {
        this.error(
          t.pos,
          `'${t.value}' (UpdateList) is out of CAP profile — only 'Add' may produce triples (C1)`,
          'out_of_profile',
        );
        return { ast: null, errors: this.errors };
      }
      if (t.kind === 'KW_BIND') {
        this.error(
          t.pos,
          'Multiple Bind clauses — CAP allows at most one Bind per advisory (C2)',
          'out_of_profile',
        );
        return { ast: null, errors: this.errors };
      }
      if (t.kind === 'KW_ADD') {
        adds.push(this.parseAdd());
        if (this.errors.length > 0) return { ast: null, errors: this.errors };
        continue;
      }
      // Unknown token at top level
      this.error(
        t.pos,
        `Unexpected token '${t.value}' (expected 'Add' or end of file)`,
        'syntax',
      );
      return { ast: null, errors: this.errors };
    }

    if (adds.length === 0) {
      const eofPos = this.peek().pos;
      this.error(
        eofPos,
        'CAP advisory must contain at least one Add operation (C1)',
        'out_of_profile',
      );
      return { ast: null, errors: this.errors };
    }

    if (!envelope) {
      // Empty envelope still produces an AST; the validator will flag C6.
      envelope = { types: [], extra: [] };
    }

    const ast: CapAst = {
      prefixes: { ...this.prefixes },
      envelope,
      bind,
      adds,
    };
    return { ast, errors: [] };
  }

  /* ────────── @prefix ────────── */

  private parsePrefixDecl(): void {
    this.consume('KW_PREFIX');
    const nsTok = this.expect('PNAME_NS', "Expected prefix name (e.g., 'foo:')");
    if (!nsTok) return;
    const iriTok = this.expect('IRIREF', "Expected IRI for @prefix");
    if (!iriTok) return;
    this.expect('DOT', "Expected '.' to terminate @prefix");
    this.prefixes[nsTok.value] = iriTok.value;
  }

  /* ────────── Envelope ────────── */

  private isEnvelopeStart(): boolean {
    // Envelope begins with `<>` (an IRIREF whose value is "" — the document IRI).
    const t = this.peek();
    return t.kind === 'IRIREF' && t.value === '';
  }

  private parseEnvelope(): CapEnvelope {
    const startTok = this.consume('IRIREF'); // <>
    const env: {
      pos: CapPosition;
      types: string[];
      profileVersion?: string;
      advisoryClass?: string;
      issuer?: string;
      issuerName?: string;
      issuedAt?: string;
      advisoryId?: string;
      supersedes?: string;
      humanSummary?: string;
      applicableUntil?: string;
      evidenceUrl?: string;
      extra: { predicate: string; object: CapTerm; pos: CapPosition }[];
    } = {
      pos: startTok.pos,
      types: [],
      extra: [],
    };

    // Predicate-object list
    do {
      const predTok = this.peek();
      if (predTok.kind === 'A') {
        this.consume('A');
        const objs = this.parseObjectList();
        for (const o of objs) {
          if (o.kind === 'iri') env.types.push(o.value);
        }
      } else {
        const pred = this.parsePredicate();
        if (!pred) return env;
        const objs = this.parseObjectList();
        // Map known advisory:* predicates onto envelope fields.
        for (const o of objs) {
          this.assignEnvelopeField(env, pred, o, predTok.pos);
        }
      }
      if (this.peek().kind === 'SEMI') {
        this.consume('SEMI');
        continue;
      }
      break;
    } while (true);

    this.expect('DOT', "Expected '.' to terminate envelope");
    return env;
  }

  private assignEnvelopeField(
    env: {
      types: string[];
      profileVersion?: string;
      advisoryClass?: string;
      issuer?: string;
      issuerName?: string;
      issuedAt?: string;
      advisoryId?: string;
      supersedes?: string;
      humanSummary?: string;
      applicableUntil?: string;
      evidenceUrl?: string;
      extra: { predicate: string; object: CapTerm; pos: CapPosition }[];
    },
    predicate: string,
    object: CapTerm,
    pos: CapPosition,
  ): void {
    const local = predicate.startsWith(ADVISORY_NS) ? predicate.slice(ADVISORY_NS.length) : '';
    const stringVal = (): string | undefined => {
      if (object.kind === 'literal') return object.value;
      if (object.kind === 'iri') return object.value;
      return undefined;
    };
    switch (local) {
      case 'profileVersion':
        env.profileVersion = stringVal();
        return;
      case 'advisoryClass':
        env.advisoryClass = stringVal();
        return;
      case 'issuer':
        env.issuer = stringVal();
        return;
      case 'issuerName':
        env.issuerName = stringVal();
        return;
      case 'issuedAt':
        env.issuedAt = stringVal();
        return;
      case 'advisoryId':
        env.advisoryId = stringVal();
        return;
      case 'supersedes':
        env.supersedes = stringVal();
        return;
      case 'humanSummary':
        env.humanSummary = stringVal();
        return;
      case 'applicableUntil':
        env.applicableUntil = stringVal();
        return;
      case 'evidenceUrl':
        env.evidenceUrl = stringVal();
        return;
      default:
        env.extra.push({ predicate, object, pos });
    }
  }

  /* ────────── Bind ────────── */

  private parseBind(): CapBind {
    const bindTok = this.consume('KW_BIND');
    const varTok = this.expect('VAR', "Expected variable after 'Bind'");
    if (!varTok) return this.errBind(bindTok.pos);

    // Optional binding namespace IRI
    let bindingNamespace: string | undefined;
    if (this.peek().kind === 'IRIREF') {
      bindingNamespace = this.consume('IRIREF').value;
    }

    // Path expression — CAP requires `?var <predicate> <literal>`
    const subjectTok = this.expect('VAR', 'CAP Bind path must begin with the bound variable (C2)');
    if (!subjectTok) return this.errBind(bindTok.pos);
    if (subjectTok.value !== varTok.value) {
      this.error(
        subjectTok.pos,
        `Bind path subject ?${subjectTok.value} must match the bound variable ?${varTok.value} (C2)`,
        'invalid_bind',
      );
      return this.errBind(bindTok.pos);
    }
    const predicate = this.parsePredicate();
    if (!predicate) return this.errBind(bindTok.pos);

    const objectTok = this.peek();
    if (objectTok.kind !== 'STRING') {
      this.error(
        objectTok.pos,
        'CAP Bind path object must be a string literal (C2: single-identifier match against a fully-quoted literal)',
        'invalid_bind',
      );
      return this.errBind(bindTok.pos);
    }
    const objectTerm = this.parseLiteral();

    this.expect('DOT', "Expected '.' to terminate Bind");

    return {
      variable: varTok.value,
      bindingNamespace,
      subject: { kind: 'variable', value: varTok.value, pos: subjectTok.pos },
      predicate,
      object: objectTerm,
      pos: bindTok.pos,
    };
  }

  private errBind(pos: CapPosition): CapBind {
    return {
      variable: '',
      subject: { kind: 'variable', value: '', pos },
      predicate: '',
      object: { kind: 'literal', value: '', pos },
      pos,
    };
  }

  /* ────────── Add ────────── */

  private parseAdd(): CapAdd {
    const addTok = this.consume('KW_ADD');
    this.expect('LBRACE', "Expected '{' after Add");
    const triples: CapTriple[] = [];

    while (this.peek().kind !== 'RBRACE' && this.peek().kind !== 'EOF') {
      const stmtTriples = this.parseTripleStatement();
      triples.push(...stmtTriples);
      if (this.peek().kind === 'DOT') {
        this.consume('DOT');
      } else if (this.peek().kind !== 'RBRACE') {
        this.error(
          this.peek().pos,
          `Expected '.' or '}' inside Add block, got '${this.peek().value}'`,
          'invalid_add',
        );
        break;
      }
    }

    this.expect('RBRACE', "Expected '}' to close Add block");
    this.expect('DOT', "Expected '.' to terminate Add");
    return { triples, pos: addTok.pos };
  }

  private parseTripleStatement(): CapTriple[] {
    const subject = this.parseSubject();
    if (!subject) return [];
    const subjectPos = subject.pos ?? this.peek().pos;
    const out: CapTriple[] = [];
    do {
      const predTok = this.peek();
      let predicate: string;
      if (predTok.kind === 'A') {
        this.consume('A');
        predicate = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
      } else {
        const p = this.parsePredicate();
        if (!p) return out;
        predicate = p;
      }
      const objs = this.parseObjectList();
      for (const o of objs) {
        out.push({ subject, predicate, object: o, pos: subjectPos });
      }
      if (this.peek().kind === 'SEMI') {
        this.consume('SEMI');
        // Allow trailing ';' before '.' or '}'
        if (this.peek().kind === 'DOT' || this.peek().kind === 'RBRACE') break;
        continue;
      }
      break;
    } while (true);
    return out;
  }

  private parseSubject(): CapTerm | null {
    const t = this.peek();
    switch (t.kind) {
      case 'IRIREF':
        this.consume('IRIREF');
        return { kind: 'iri', value: t.value, pos: t.pos };
      case 'PNAME_LN': {
        this.consume('PNAME_LN');
        const iri = this.expandPname(t.value, t.pos);
        if (iri == null) return null;
        return { kind: 'iri', value: iri, pos: t.pos };
      }
      case 'VAR':
        this.consume('VAR');
        return { kind: 'variable', value: t.value, pos: t.pos };
      case 'BNODE':
        this.consume('BNODE');
        return { kind: 'bnode', value: t.value, pos: t.pos };
      default:
        this.error(
          t.pos,
          `Expected subject (IRI, prefix:local, ?var, or _:bnode), got '${t.value}'`,
          'syntax',
        );
        return null;
    }
  }

  private parsePredicate(): string | null {
    const t = this.peek();
    if (t.kind === 'IRIREF') {
      this.consume('IRIREF');
      return t.value;
    }
    if (t.kind === 'PNAME_LN') {
      this.consume('PNAME_LN');
      return this.expandPname(t.value, t.pos);
    }
    if (t.kind === 'A') {
      this.consume('A');
      return 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    }
    this.error(t.pos, `Expected predicate (IRI or prefix:local), got '${t.value}'`, 'syntax');
    return null;
  }

  private parseObjectList(): CapTerm[] {
    const out: CapTerm[] = [];
    const first = this.parseObject();
    if (first) out.push(first);
    while (this.peek().kind === 'COMMA') {
      this.consume('COMMA');
      const next = this.parseObject();
      if (next) out.push(next);
    }
    return out;
  }

  private parseObject(): CapTerm | null {
    const t = this.peek();
    switch (t.kind) {
      case 'IRIREF':
        this.consume('IRIREF');
        return { kind: 'iri', value: t.value, pos: t.pos };
      case 'PNAME_LN': {
        this.consume('PNAME_LN');
        const iri = this.expandPname(t.value, t.pos);
        if (iri == null) return null;
        return { kind: 'iri', value: iri, pos: t.pos };
      }
      case 'VAR':
        this.consume('VAR');
        return { kind: 'variable', value: t.value, pos: t.pos };
      case 'BNODE':
        this.consume('BNODE');
        return { kind: 'bnode', value: t.value, pos: t.pos };
      case 'STRING':
        return this.parseLiteral();
      case 'BOOL':
        this.consume('BOOL');
        return {
          kind: 'literal',
          value: t.value,
          datatype: 'http://www.w3.org/2001/XMLSchema#boolean',
          pos: t.pos,
        };
      case 'NUMBER':
        this.consume('NUMBER');
        return {
          kind: 'literal',
          value: t.value,
          datatype: t.value.includes('.') || /[eE]/.test(t.value)
            ? 'http://www.w3.org/2001/XMLSchema#decimal'
            : 'http://www.w3.org/2001/XMLSchema#integer',
          pos: t.pos,
        };
      default:
        this.error(t.pos, `Expected object, got '${t.value}'`, 'syntax');
        return null;
    }
  }

  private parseLiteral(): CapTerm {
    const strTok = this.consume('STRING');
    let datatype: string | undefined;
    let lang: string | undefined;
    if (this.peek().kind === 'CARET2') {
      this.consume('CARET2');
      const dt = this.peek();
      if (dt.kind === 'IRIREF') {
        this.consume('IRIREF');
        datatype = dt.value;
      } else if (dt.kind === 'PNAME_LN') {
        this.consume('PNAME_LN');
        const iri = this.expandPname(dt.value, dt.pos);
        if (iri != null) datatype = iri;
      } else {
        this.error(dt.pos, "Expected datatype IRI after '^^'", 'syntax');
      }
    } else if (this.peek().kind === 'LANGTAG') {
      lang = this.consume('LANGTAG').value;
    }
    return { kind: 'literal', value: strTok.value, datatype, lang, pos: strTok.pos };
  }

  /* ────────── Helpers ────────── */

  private expandPname(pname: string, pos: CapPosition): string | null {
    const colon = pname.indexOf(':');
    if (colon === -1) {
      this.error(pos, `Malformed prefixed name '${pname}'`, 'syntax');
      return null;
    }
    const prefix = pname.slice(0, colon);
    const local = pname.slice(colon + 1);
    const ns = this.prefixes[prefix];
    if (ns === undefined) {
      this.error(
        pos,
        `Unknown prefix '${prefix}:' (declare it with @prefix; CAP requires whitelisted vocabularies — C3)`,
        'unknown_prefix',
      );
      return null;
    }
    return ns + local;
  }

  private peek(): Token {
    return this.tokens[this.idx] ?? { kind: 'EOF', value: '', pos: { line: 0, col: 0 } };
  }

  private consume(kind: TokenKind): Token {
    const t = this.tokens[this.idx];
    if (!t || t.kind !== kind) {
      const got = t ?? { kind: 'EOF', value: '', pos: { line: 0, col: 0 } };
      this.error(got.pos, `Expected ${kind}, got ${got.kind} '${got.value}'`, 'syntax');
      return got;
    }
    this.idx += 1;
    return t;
  }

  private expect(kind: TokenKind, message: string): Token | null {
    const t = this.tokens[this.idx];
    if (!t || t.kind !== kind) {
      const got = t ?? { kind: 'EOF', value: '', pos: { line: 0, col: 0 } };
      this.error(got.pos, `${message} (got '${got.value}')`, 'syntax');
      return null;
    }
    this.idx += 1;
    return t;
  }

  private error(pos: CapPosition, message: string, code: CapParseError['code']): void {
    this.errors.push({ ...pos, message, code });
  }
}
