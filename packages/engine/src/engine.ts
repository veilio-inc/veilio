import { credentialsAmong, isOrdinaryWord, valueSpans } from './ordinaryWords.js'
import type { ValueGrammar, ValueSpan } from './ordinaryWords.js'
import { isEngineBase } from './rule-checks.js'
import {
  compileRulePattern,
  ruleBudget,
  type RuleBudget,
  type RuleMatcher,
} from './rule-pattern.js'
import type {
  AnonymizeOptions,
  AnonymizeResult,
  CommentExposure,
  CustomRuleReplace,
  CustomRuleWhitelist,
  IdentifierRole,
  RestoreOptions,
  RestoreReport,
  RestoreResult,
  StrippedItem,
  StrippedItemType,
  SymbolMap,
} from './types.js'
import {
  classKeywordsFor,
  commentSyntaxFor,
  fnKeywordsFor,
  isKeyword,
  describeLanguage,
  guessLanguage,
  type CommentSyntax,
  type Language,
  type LanguageOption,
} from './languages.js'
import {
  credentialSpans,
  detectSecrets,
  hasBlockingSecrets,
  previewSecret,
  redactionTokensOf,
  scanSecrets,
  fileKindOf,
} from './secrets.js'
import { lineIndex, positionOf } from './lines.js'
import type { RegulatedSpan, ScanOptions, SecretFinding, SecretType } from './secrets.js'
import { PRODUCT_NAME, REDACTION_PREFIX } from './product.js'
import { blankSpans, inSpan, traceSpans } from './traces.js'
import {
  isLocalTag,
  isRolePlaceholder,
  isSaneBlock,
  localBaseOf,
  MAX_PLACEHOLDER_NUMBER,
  teamBaseOf,
  usedInBlock,
} from './localFamily.js'
import {
  assertKnownOptions,
  assertObject,
  optionKeys,
  unknownKeys,
  unknownOptionError,
} from './options.js'

// Keyword sets, comment syntax and detection live in ./languages.ts. Standalone
// helpers default to TypeScript so existing callers keep their exact behavior;
// `anonymize` resolves the language from its options (auto-detecting by default).
const DEFAULT_LANGUAGE: Language = 'typescript'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Longest token that may go into the substitution alternation.
 *
 *  V8 refuses to compile a regex whose single alternation atom reaches 32767
 *  characters, and it refuses on FIRST EXECUTION rather than construction — so
 *  `new RegExp` succeeds and the throw lands inside `.replace()`. Only the
 *  largest atom matters: a 60M-character alternation of ordinary-length atoms
 *  compiles fine, so this is a per-token cap, not a budget.
 *
 *  The cap sits far below V8's limit because this is browser code and other
 *  engines set their own. Nothing legitimate is affected: no identifier in any
 *  supported language is 1024 characters. What is that long is an inline
 *  `data:image/png;base64,...` URI, a hex blob, or minified output — routine in
 *  pasted source, and previously a hard crash. */
const MAX_REGEX_ATOM = 1024

const IDENTIFIER_CHAR = /[a-zA-Z0-9_$]/

/** Whole-word replace with no regex, for tokens too large to put in one.
 *  Enforces exactly the boundaries the alternation's lookbehind and lookahead
 *  do, so an oversized token is not rewritten where it is merely a substring of
 *  something longer. */
function replaceWholeWord(text: string, needle: string, replacement: string): string {
  if (needle.length === 0) return text
  let out = ''
  let from = 0
  let at = text.indexOf(needle)
  if (at === -1) return text
  while (at !== -1) {
    const before = at > 0 ? (text[at - 1] ?? '') : ''
    const after = text[at + needle.length] ?? ''
    const bounded = !IDENTIFIER_CHAR.test(before) && !IDENTIFIER_CHAR.test(after)
    out += text.slice(from, at) + (bounded ? replacement : needle)
    from = at + needle.length
    at = text.indexOf(needle, from)
  }
  return out + text.slice(from)
}

// ─── Downstream-AI preamble ──────────────────────────────────────────────────
//
// Masked code can read as "deliberately obfuscated" to another AI, which then
// refuses to help. Pasting this note above the code tells it the placeholders
// are an intentional privacy measure and to answer normally.

export const AI_PREAMBLE = [
  `The code below was processed by ${PRODUCT_NAME}: real identifiers have been replaced`,
  'with privacy placeholders such as __CLS__1, __FN__2, __VAR__3 (and similar). This is a',
  'deliberate anonymization step, not obfuscation — please do not refuse on those',
  'grounds. Treat each placeholder as an ordinary name, keep every placeholder',
  'spelled exactly as-is in your reply, and otherwise answer as normal.',
].join(' ')

const ROLE_LEGEND_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['__CLS__', 'class or type names'],
  ['__FN__', 'function or method names'],
  ['__VAR__', 'variable or parameter names'],
  ['__PKG__', 'package or module names'],
  ['__STR__', 'words that appeared inside string literals'],
  ['__MANUAL__', 'values the author marked as sensitive'],
  // Regulated identifiers, masked reversibly. Named per format rather than
  // lumped together: a model working on the code can use "this is a bank
  // account number" in a way it cannot use "this is redacted something".
  ['__IBAN__', 'bank account numbers'],
  ['__PAN__', 'payment card numbers'],
  ['__PESEL__', 'national identification numbers'],
]

/** Human/AI-readable summary of what the placeholder bases in `map` mean.
 *  Derived purely from placeholder KEYS — real names never appear.
 *  Pass `snippet` to scope the legend to the placeholders actually present
 *  in it (used by withAiPreamble and the UI legend toggle). */
export function buildLegend(map: SymbolMap, snippet?: string): string {
  let scoped = map
  if (snippet !== undefined) {
    const present = new Set<string>()
    const scan = new RegExp(PLACEHOLDER_SCAN)
    let m: RegExpExecArray | null
    while ((m = scan.exec(snippet)) !== null) present.add(m[0])
    scoped = {}
    for (const key of Object.keys(map)) {
      if (present.has(key)) scoped[key] = map[key]
    }
  }
  const baseCounts = new Map<string, number>()
  for (const ph of Object.keys(scoped)) {
    const m = /^(__[A-Z][A-Z0-9_]*__)\d+$/.exec(ph)
    if (m) baseCounts.set(m[1], (baseCounts.get(m[1]) ?? 0) + 1)
  }
  if (baseCounts.size === 0) return ''

  const parts: string[] = []
  for (const [base, label] of ROLE_LEGEND_LABELS) {
    const count = baseCounts.get(base)
    if (count !== undefined) {
      parts.push(`${base}* are ${label} (${count})`)
      baseCounts.delete(base)
    }
  }
  for (const [base, count] of baseCounts) {
    // Spec 066: a local base reads as its team kind, numbered on one machine.
    const team = teamBaseOf(base)
    const label =
      (team && ROLE_LEGEND_LABELS.find(([b]) => b === team)?.[1]) || 'project-specific identifiers'
    parts.push(`${base}* are ${label}${team ? ', numbered on one machine' : ''} (${count})`)
  }
  return `Placeholder legend: ${parts.join('; ')}.`
}

/** Matches placeholder-shaped tokens as whole words, used both to detect
 *  placeholders already in source (anonymize) and to scope a legend to the
 *  placeholders actually present in a snippet (withAiPreamble). */
const PLACEHOLDER_SCAN = /(?<![a-zA-Z0-9_$])__[A-Z][A-Z0-9_]*__\d*(?![a-zA-Z0-9_$])/g

/** Prepend the downstream-AI preamble (and, when a map is given, a placeholder
 *  legend) to anonymized code, ready to paste. The legend is scoped to the
 *  placeholders actually present in `anonymized` — not the whole map — so a
 *  one-line snippet doesn't advertise the full size (or namespace) of a
 *  larger (e.g. team-shared) map it happens to be a subset of. */
export function withAiPreamble(anonymized: string, map?: SymbolMap): string {
  const legend = map ? buildLegend(map, anonymized) : ''
  return legend ? `${AI_PREAMBLE}\n${legend}\n\n${anonymized}` : `${AI_PREAMBLE}\n\n${anonymized}`
}

// ─── Comment-aware scanning ──────────────────────────────────────────────────
//
// Identifiers inside STRING/template literals are masked on purpose (a class
// name in a log message would otherwise leak). Identifiers inside COMMENTS are
// NOT masked — comments are prose, and masking their words produces ciphertext
// that reads as obfuscation and trips downstream-AI refusals.
//
// So we split source into segments, flagging only comment spans. Strings and
// templates stay in non-comment segments (still maskable). This is a lexical
// scanner, not a full parser, with two modes. For masking a `/` reads as
// division, except that a TypeScript/JavaScript regex literal holding `//` or
// `/*` is code (spec 085 L7), so the rare case of a regex literal containing
// only a quote (e.g. `/'/`) is not handled. For restore's JSDoc search
// (`forRestore`) it reads every regex literal, markdown fence lines and stray
// backticks - see tokenizeForMasking.
//
// Comment syntax is per-language. Assuming `//` everywhere meant Python and
// Ruby `#` comments were scanned as code and their prose masked into
// ciphertext — the precise failure this exemption exists to prevent.

interface Segment {
  text: string
  isComment: boolean
  isString?: boolean
  isModuleSpecifier?: boolean
}

/** True when the string starting at `quotePos` is a module specifier:
 *  preceded (ignoring whitespace) by the word `from`/`import`, or by `(`
 *  belonging to `require(...)` / `import(...)`. */
function isModuleSpecifierContext(code: string, quotePos: number): boolean {
  let j = quotePos - 1
  while (j >= 0 && /\s/.test(code[j])) j--
  if (j < 0) return false
  if (code[j] === '(') {
    let k = j - 1
    while (k >= 0 && /\s/.test(code[k])) k--
    const end = k + 1
    while (k >= 0 && /[a-zA-Z0-9_$]/.test(code[k])) k--
    const word = code.slice(k + 1, end)
    return word === 'require' || word === 'import'
  }
  const end = j + 1
  while (j >= 0 && /[a-zA-Z0-9_$]/.test(code[j])) j--
  const word = code.slice(j + 1, end)
  return word === 'from' || word === 'import'
}

// A URL scheme right before `//`. A fixed list, not any `word:`, because
// `default:// note`, a label or an object key followed by a comment must stay
// a comment. The scheme must not be the tail of a longer word.
const URL_SCHEME_BEFORE = /(?<![A-Za-z0-9_$])(?:file|https?|wss?|s?ftps?|ssh|git|svn):$/

// After one of these words a `/` opens a regex literal, not a division.
const REGEX_AFTER_WORD =
  /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/

/** `[true, end]` for the regex literal whose `/` is at `at`; `[false, -1]` when
 *  that `/` is a division; `[false, lineEnd]` when no regex closes on the line.
 *  A `/` after a name, a number, a string, `)`, `]`, a postfix `++`/`--` or a
 *  `<` (a JSX closing tag, `</div>`) divides; anywhere else it opens a regex,
 *  which ends on the line it began on.
 *  shortcut: `)` and `}` are guessed (`if (x) /re/` reads as division, a `/`
 *  after an object literal as a regex); a real parser would know. */
function regexLiteralEnd(code: string, at: number): [boolean, number] {
  let j = at - 1
  while (j >= 0 && /\s/.test(code[j])) j--
  if (j >= 0 && (code[j] === '<' || (/[+-]/.test(code[j]) && code[j - 1] === code[j])))
    return [false, -1]
  if (
    j >= 0 &&
    /[\w$)\]'"`]/.test(code[j]) &&
    !REGEX_AFTER_WORD.test(code.slice(Math.max(0, j - 10), j + 1))
  )
    return [false, -1]
  let inClass = false
  for (let k = at + 1; k < code.length; k++) {
    const ch = code[k]
    if (ch === '\n' || ch === '\r') return [false, k]
    if (ch === '\\') {
      // Not past a line break: a regex literal never spans lines, escaped or not.
      if (code[k + 1] !== '\n' && code[k + 1] !== '\r') k++
    } else if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      k++
      while (k < code.length && /[a-z]/i.test(code[k])) k++
      return [true, k]
    }
  }
  return [false, code.length]
}

// A markdown fence line: three or more backticks or tildes at a line start.
const FENCE_LINE = /[ \t]*(?:`{3,}|~{3,})[^\n]*/y

/** `forRestore`: the reading restore's JSDoc search needs, for code that may sit
 *  in a markdown answer. Masking does not ask for it, and reads as it always did
 *  except for a regex literal holding a comment opener, which is code there too.
 *  - A regex literal is code, so a quote or comment opener inside it starts nothing.
 *  - A fence line in code is code: its backticks open no template literal. One
 *    inside a comment is part of it.
 *  - A quote that never closes (a stray backtick in prose), or that reaches a
 *    fence line first, opens nothing; neither does a later one of that quote
 *    character before the end, or before that fence line.
 *    shortcut: two stray backticks still pair up, and a `~~~` line inside a
 *    template literal ends it, which flips which backticks open and close
 *    until the next fence line; only a parser of the prose around the code
 *    could tell them apart. */
function tokenizeForMasking(
  code: string,
  language: Language = DEFAULT_LANGUAGE,
  forRestore = false
): Segment[] {
  const syntax: CommentSyntax = commentSyntaxFor(language)
  const segments: Segment[] = []
  let buf = ''
  let bufIsComment = false

  const flush = (nextIsComment: boolean) => {
    if (buf) segments.push({ text: buf, isComment: bufIsComment })
    buf = ''
    bufIsComment = nextIsComment
  }

  const startsWithAt = (token: string, at: number): boolean => code.startsWith(token, at)

  let i = 0
  let noRegexBefore = -1
  // A quote character opens nothing before this offset (see `forRestore`).
  const proseBefore = new Map<string, number>()
  /** The end of the fence line starting at `at`, or -1 when none does. */
  const fenceEnd = (at: number): number => {
    FENCE_LINE.lastIndex = at
    return FENCE_LINE.test(code) ? FENCE_LINE.lastIndex : -1
  }
  const n = code.length
  while (i < n) {
    const c = code[i]

    const fence = forRestore && (i === 0 || code[i - 1] === '\n') ? fenceEnd(i) : -1
    if (fence !== -1) {
      buf += code.slice(i, fence)
      i = fence
      continue
    }

    // Triple-quoted prose (Python docstrings) is documentation, not data —
    // treat it as a comment so its sentences survive intact.
    const doc = syntax.docstring.find((d) => startsWithAt(d, i))
    if (doc !== undefined) {
      flush(true)
      buf += doc
      i += doc.length
      while (i < n && !startsWithAt(doc, i)) buf += code[i++]
      if (i < n) {
        buf += doc
        i += doc.length
      }
      flush(false)
      continue
    }

    const lineOpener = syntax.line.find(
      (o) => startsWithAt(o, i) && !syntax.notLineOpener?.some((t) => startsWithAt(t, i))
    )
    if (
      lineOpener === '//' &&
      syntax.lineBounded.length > 0 &&
      URL_SCHEME_BEFORE.test(code.slice(Math.max(0, i - 16), i))
    ) {
      // The `//` of `file:///…` or `https://…`: part of a URL, which is masked
      // like code, not a comment left as written.
      buf += '//'
      i += 2
      continue
    }
    if (lineOpener !== undefined) {
      flush(true)
      while (i < n && code[i] !== '\n') buf += code[i++]
      flush(false)
      continue
    }

    // Ruby's `=begin`/`=end` only at a line start: `state=begin_x(...)` is code.
    const delimiterAt = (token: string, at: number): boolean =>
      startsWithAt(token, at) && (!syntax.blockAtLineStart || at === 0 || code[at - 1] === '\n')
    const blockPair = syntax.block.find(([open]) => delimiterAt(open, i))
    if (blockPair !== undefined) {
      const [open, close] = blockPair
      flush(true)
      buf += open
      i += open.length
      while (i < n && !delimiterAt(close, i)) buf += code[i++]
      if (i < n) {
        buf += close
        i += close.length
      }
      flush(false)
      continue
    }

    if ((forRestore || syntax.regexLiterals) && c === '/' && i >= noRegexBefore) {
      const [closed, end] = regexLiteralEnd(code, i)
      // Masking consumes only a literal that holds a comment opener (spec 085
      // L7: `/^https?:\/\//`, `/\/*$/`), which it would otherwise read as a
      // comment; any other literal reads exactly as it always did.
      if (closed && (forRestore || /\/[/*]/.test(code.slice(i + 1, end)))) {
        buf += code.slice(i, end)
        i = end
        continue
      }
      // No regex closed before the line end: the rest of the line's `/`s read
      // as divisions, or a line of them is quadratic. shortcut: a `[` in the
      // failed scan can hide a later regex's close; a lexer with state fixes it.
      noRegexBefore = end
    }

    if (syntax.quotes.includes(c) && i >= (proseBefore.get(c) ?? 0)) {
      // Emit the whole string/template literal as its own tagged segment so
      // role classification can tell string words and module specifiers apart.
      // Still maskable (isComment: false); escape handling unchanged.
      flush(false)
      const isModuleSpecifier = isModuleSpecifierContext(code, i)
      const opened = i
      let closed = false
      let str = c
      i++
      const bounded = syntax.lineBounded.includes(c)
      while (i < n) {
        // An unterminated '…' in a language where it cannot span lines ends at
        // the line break, which stays outside the string.
        if (bounded && code[i] === '\n') break
        if (forRestore && !bounded && code[i - 1] === '\n' && fenceEnd(i) !== -1) break
        str += code[i]
        if (code[i] === '\\') {
          if (i + 1 < n) str += code[++i]
          i++
          continue
        }
        if (code[i] === c) {
          closed = true
          i++
          break
        }
        i++
      }
      if (forRestore && !closed && !bounded) {
        proseBefore.set(c, i)
        buf += c
        i = opened + 1
        continue
      }
      segments.push({ text: str, isComment: false, isString: true, isModuleSpecifier })
      continue
    }

    buf += c
    i++
  }
  flush(false)
  return segments
}

/** Replace comment characters with spaces (newlines kept) so identifier
 *  extraction skips comments while preserving token boundaries and line counts. */
function blankComments(code: string, language: Language = DEFAULT_LANGUAGE): string {
  return tokenizeForMasking(code, language)
    .map((s) => (s.isComment ? s.text.replace(/[^\n]/g, ' ') : s.text))
    .join('')
}

// ─── Comment exposure ────────────────────────────────────────────────────────
//
// The engine's largest silent leak, made loud. Everything above masks
// identifiers; comment prose is deliberately left alone because masking it
// produces ciphertext that reads as obfuscation. That trade is right, and it is
// also invisible — the anonymized text looks handled, and the sentence naming a
// customer went out with it.
//
// So: count it and say so. What is NOT here is as important as what is. There is
// no attempt to decide whether a comment is sensitive, because deciding that
// means knowing what its words mean, and the day this engine needs a model to
// tell it that is the day the supply-chain argument for pasting its output into
// one stops working. Grading is structural — how many, how much, and whether
// they sit above the code or inside it.

/** A block carries prose if there is anything in it a reader would read. Purely
 *  decorative comments — a rule of dashes, a row of box characters — are not a
 *  leak, and counting them is how the count stops being believed. */
const COMMENT_PROSE = /[\p{L}\p{N}]/u

/** Tokens this engine minted, and only those. `PLACEHOLDER_SCAN` also matches
 *  `__GNUC__` and `__init__`, which are somebody's code and do leave unmasked —
 *  excluding them would under-report, and under-reporting is the direction that
 *  reassures wrongly. Every placeholder we mint carries a counter; redaction
 *  tokens carry the prefix instead. */
const MASKED_TOKEN = new RegExp(
  `(?<![a-zA-Z0-9_$])(?:__[A-Z][A-Z0-9_]*__\\d+|${REDACTION_PREFIX}[A-Z0-9_]*__)(?![a-zA-Z0-9_$])`,
  'g'
)

/** Two newlines with only whitespace between them — an empty line. */
const BLANK_LINE = /\n[ \t]*\n/

/** A leading `#!` line, plus whatever whitespace follows it, and nothing else. */
const SHEBANG_ONLY = /^\s*#![^\n]*\s*$/

interface OpenBlock {
  characters: number
  prose: boolean
  afterCode: boolean
}

/** Summarize already-tokenized segments. Shares the scanner with masking rather
 *  than adding a second one, so the count can never describe different spans
 *  from the ones actually left verbatim. */
function summarizeComments(segments: readonly Segment[]): CommentExposure {
  let total = 0
  let inline = 0
  let characters = 0
  let codeSeen = false
  let open: OpenBlock | null = null

  const close = (): void => {
    if (open === null) return
    // Whitespace and decoration do not count as a leak, so a block that turned
    // out to hold neither letters nor digits is dropped entirely — not counted
    // and not charged for its characters.
    if (open.prose) {
      total++
      characters += open.characters
      if (open.afterCode) inline++
    }
    open = null
  }

  for (const segment of segments) {
    if (segment.isComment) {
      // Placeholders sitting in a comment are the marks the user already made.
      // They leave, but they leave masked, so charging for them would report
      // the same exposure before and after the gesture that fixed it — and a
      // comment reduced to nothing but placeholders drops out entirely, which
      // is the honest answer: there is no prose left in it to leak.
      const unmasked = segment.text.replace(MASKED_TOKEN, '')
      open ??= { characters: 0, prose: false, afterCode: codeSeen }
      // Per line, not per segment. A block comment is one segment carrying its
      // own newlines and ` * ` gutter, where the same content written as `//`
      // lines is several segments whose indentation was never included — count
      // the segment whole and the block reads ~30% larger for saying the same
      // thing, which makes the number about syntax rather than about exposure.
      open.characters += unmasked.split('\n').reduce((n, line) => n + line.trim().length, 0)
      open.prose ||= COMMENT_PROSE.test(unmasked)
      continue
    }
    if (segment.text.trim() === '') {
      // The gap between two consecutive line comments is a bare newline, and
      // treating it as code would report a five-line header as five separate
      // comments. A BLANK LINE is different: it is how a writer separates two
      // notes about two things, and merging across it under-reports — three
      // notes announced as one, in the direction that reassures.
      if (!BLANK_LINE.test(segment.text)) continue
      close()
      continue
    }
    // A shebang is not a comment in most of these languages, so it would read as
    // the file's first code and demote the licence header beneath it to "inside
    // the body". CLI entry points are exactly the files that carry one.
    if (!codeSeen && SHEBANG_ONLY.test(segment.text)) continue
    close()
    codeSeen = true
  }
  close()

  return { total, inline, characters, severity: inline > 0 ? 'medium' : 'low' }
}

/**
 * How much comment prose this source would send unmasked.
 *
 * `anonymize` returns the same measurement for the text it produced, which is
 * the number to prefer. This entry point exists for the moments after that,
 * when a manual mark has just moved a name out of a comment — or an unmark has
 * put one back — and the figure on screen would otherwise describe the previous
 * version of the text.
 */
export function measureCommentExposure(
  code: string,
  language: LanguageOption = 'auto'
): CommentExposure {
  // `describeLanguage`, not `resolveLanguage`: one path decides the language in
  // this file. The fallback flag is dropped here because the caller already has
  // it from the `anonymize` that produced this text — and it qualifies this
  // number too. A Ruby file read as TypeScript has its `#` comments scanned as
  // code, so the count would be honestly derived and wrong about the file.
  return summarizeComments(tokenizeForMasking(code, describeLanguage(code, language).language))
}

// ─── Role classification ─────────────────────────────────────────────────────
//
// Lexical, per-occurrence role detection. An identifier seen in several roles
// takes the highest-priority one. Mislabels are cheap: restore is format-
// agnostic, and a wrong role still carries more signal than an opaque __P<n>__.

const ROLE_PRIORITY: Record<IdentifierRole, number> = {
  class: 4,
  function: 3,
  package: 2,
  variable: 1,
  string: 0,
}

/** Base for spans the author marked by hand. Not an IdentifierRole: a manual
 *  mark is frequently not an identifier at all — a surname in a comment, a bare
 *  account number — which is the entire reason the feature exists. */
export const MANUAL_BASE = '__MANUAL__'

/** Raised when a manual mark is refused. Carries the offending term so a caller
 *  can point at it rather than re-deriving which one failed. */
export class ManualMaskError extends Error {
  readonly term: string
  constructor(term: string, message: string) {
    super(message)
    this.name = 'ManualMaskError'
    this.term = term
  }
}

/** Mask author-marked spans as literal text, before identifier extraction.
 *
 *  One pass over an alternation sorted longest-first, matching the substitution
 *  in `anonymize` and `restore`: replacing term by term would let a later term
 *  match inside a placeholder an earlier one just inserted.
 *
 *  A term that scans as a credential is refused rather than masked. A manual
 *  mask is reversible and lands in the SymbolMap — the same map that gets
 *  exported to disk and synced — so masking a live key would persist the
 *  secret, which is precisely what the one-way redaction path exists to stop.
 *  The credential has already been redacted irreversibly by the time we get
 *  here; there is nothing left for the user to usefully mark. */
function applyManualMasks(
  code: string,
  requested: readonly string[],
  credentials: ReadonlySet<string>,
  fromMap: readonly string[],
  map: SymbolMap,
  reverseExisting: Record<string, string>,
  mint: Mint,
  language: Language
): string {
  // Replayed means "came from the map and was not asked for again". Deduping the
  // two lists into one and testing membership in the map would exempt a term the
  // user is marking right now just because a prior session had marked it — the
  // way round the refusal, reachable by marking the same word twice.
  const requestedNow = new Set(requested)
  const replayed = new Set(fromMap.filter((t) => !requestedNow.has(t)))
  const wanted = [...new Set([...fromMap, ...requested])].filter((t) => t.trim().length > 0)
  if (wanted.length === 0) return code

  const applicable: string[] = []
  for (const term of wanted) {
    if ((credentials.has(term) && !replayed.has(term)) || hasBlockingSecrets(detectSecrets(term))) {
      throw new ManualMaskError(
        term,
        'Refusing to mask a detected credential: a manual mask is reversible and is written to the map. Credentials are redacted one-way instead.'
      )
    }
    // Marking a placeholder would map one placeholder to another, and restore
    // is a single pass — it would substitute `__MANUAL__1` back to the literal
    // text `__FN__1` and stop, silently dropping the real name. Reachable by
    // double-clicking a placeholder in the output, which is the most visually
    // obvious thing in that panel.
    if (PLACEHOLDER_TOKEN.test(term)) {
      throw new ManualMaskError(
        term,
        'That is already a placeholder. Marking it would map one placeholder to another, and the original name would not survive restore.'
      )
    }
    // Manual marks match literal text anywhere, which is the whole feature —
    // and is why a keyword is catastrophic rather than merely wrong. Marking a
    // word read in a comment (`if`, `class`, `return` are ordinary English)
    // rewrites every keyword of that name in the code as well, and the file
    // stops parsing. Refused rather than fixed up, because there is no reading
    // of "mask this" that survives replacing the language's own grammar.
    //
    // Only for a term being marked NOW. Whether a word is a keyword depends on
    // the language, and a map outlives the file it was made against: `def` is
    // markable in a TypeScript comment and is Python's grammar, and a map
    // carrying that mark is a normal artifact — saved, exported, synced. Throwing
    // on replay would turn it into a file that cannot be anonymized at all, which
    // is a worse outcome than the mark that no longer applies. A stale mark
    // degrades; it does not detonate.
    if (isKeyword(term, language)) {
      if (replayed.has(term)) continue
      throw new ManualMaskError(
        term,
        `“${term}” is a keyword in this language. Masking it would replace it everywhere in the code, not just where you read it, and the result would not compile.`
      )
    }
    applicable.push(term)
    if (reverseExisting[term]) continue
    const placeholder = mint(MANUAL_BASE)
    map[placeholder] = term
    reverseExisting[term] = placeholder
  }

  if (applicable.length === 0) return code

  // Placeholder-shaped spans are matched FIRST and passed through untouched, so
  // a term can never match inside one. Without this, marking `FN` rewrites the
  // middle of `__FN__1` and produces `____MANUAL__1__1` — the UI re-anonymizes
  // its own output, so the text being masked is full of placeholders by then.
  const ordered = applicable.slice().sort((a, b) => b.length - a.length)
  const pattern = new RegExp(
    `${PLACEHOLDER_SCAN.source}|${ordered.map(escapeRegex).join('|')}`,
    'g'
  )
  return code.replace(pattern, (match) => reverseExisting[match] ?? match)
}

/** Placeholder base per regulated format.
 *
 *  Their own roles rather than a shared one, because the output's job is to be
 *  worked on by a model: "this is a bank account number" is information it can
 *  use, where "this is a redacted something" is not.
 *
 *  Deliberately NOT members of `IdentifierRole`. That union is for roles derived
 *  from a language's grammar and `ROLE_PRIORITY` is keyed by it — extending it
 *  would force entries ranking a card number against a function name, a
 *  comparison with no meaning. These ride beside `__MANUAL__`, which is in the
 *  same position for the same reason: masked reversibly, but not an identifier
 *  the grammar produced. */
export const REGULATED_BASES: Partial<Record<SecretType, string>> = {
  iban: '__IBAN__',
  'payment-card': '__PAN__',
  pesel: '__PESEL__',
}

/**
 * Mask detected regulated identifiers reversibly, into the same map.
 *
 *  Deliberately a near-twin of `applyManualMasks`, and called straight after it
 *  — the two are the same operation with different triggers, so they share the
 *  machinery rather than each growing their own:
 *
 *   - `reverseExisting` keys on the VALUE, so repeated occurrences of one IBAN
 *     share a placeholder and a value already in `existingMap` reuses its own.
 *     One mechanism answers both.
 *   - `PLACEHOLDER_SCAN` is matched FIRST in the alternation, so a value can
 *     never match inside a placeholder inserted earlier in the same pass.
 *   - Longest-first, so a value contained in another is not half-replaced.
 *
 *  ORDER IS LOAD-BEARING: this runs AFTER manual marks, so a value the author
 *  marked by hand is already in `reverseExisting` and keeps its `__MANUAL__n`
 *  placeholder. That single fact is the whole implementation of "a manual mark
 *  wins" — there is no precedence function. Swap the two calls and the rule
 *  silently inverts, which is why it has a test of its own.
 *
 *  Unlike manual marks there is no keyword check and no refusal path: these
 *  values are checksum-confirmed account, card and national-ID numbers, so they
 *  cannot collide with a language's grammar. */
function applyRegulatedMasks(
  code: string,
  spans: readonly RegulatedSpan[],
  map: SymbolMap,
  reverseExisting: Record<string, string>,
  mint: Mint
): string {
  if (spans.length === 0) return code

  const applicable: string[] = []
  for (const span of spans) {
    const base = REGULATED_BASES[span.type]
    if (base === undefined) continue
    applicable.push(span.value)
    if (reverseExisting[span.value]) continue
    const placeholder = mint(base)
    map[placeholder] = span.value
    reverseExisting[span.value] = placeholder
  }

  if (applicable.length === 0) return code

  const ordered = [...new Set(applicable)].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(
    `${PLACEHOLDER_SCAN.source}|${ordered.map(escapeRegex).join('|')}`,
    'g'
  )
  return code.replace(pattern, (match) => reverseExisting[match] ?? match)
}

/** Terms already masked by hand in a prior pass, recovered from the map.
 *
 *  Re-derived rather than stored alongside it: the map is the only artifact
 *  that survives a reload, a `.veilio` export and a sync, so anything kept
 *  beside it would be the thing that goes missing. */
export function manualTermsIn(map: SymbolMap): string[] {
  return Object.entries(map)
    .filter(
      ([placeholder]) =>
        placeholder.startsWith(MANUAL_BASE) ||
        // A mark numbered locally (spec 066) is replayed the same way.
        teamBaseOf(placeholder.replace(/\d+$/, '')) === MANUAL_BASE
    )
    .map(([, term]) => term)
}

/** Placeholder base per role — these ride the same named-counter machinery
 *  as custom replace rules (__CLS__1, __FN__2, ...). */
export const ROLE_BASES: Record<IdentifierRole, string> = {
  class: '__CLS__',
  function: '__FN__',
  package: '__PKG__',
  variable: '__VAR__',
  string: '__STR__',
}

/** The identifier-shaped word ending right before `pos` (only whitespace between
 *  it and `pos`), or undefined if there isn't one. Mirrors the backward scan in
 *  isModuleSpecifierContext; index-based so it never copies the source string. */
function precedingWord(text: string, pos: number): string | undefined {
  let j = pos - 1
  while (j >= 0 && /\s/.test(text[j])) j--
  if (j < 0) return undefined
  const end = j + 1
  while (j >= 0 && /[a-zA-Z0-9_$]/.test(text[j])) j--
  const word = text.slice(j + 1, end)
  if (word.length === 0 || !/[a-zA-Z_$]/.test(word[0])) return undefined
  return word
}

/** True when the next non-whitespace character at/after `pos` is `(` — used to
 *  detect call-site identifiers (`foo(...)`) without slicing the source string. */
function isCallParen(text: string, pos: number): boolean {
  let j = pos
  while (j < text.length && /\s/.test(text[j])) j++
  return text[j] === '('
}

/** Classify every identifier-shaped token (keywords excluded in code context) by
 *  its strongest observed role. `language` selects the keyword and role-hint
 *  sets; it defaults to TypeScript so standalone callers keep prior behavior. */
export function classifyIdentifiers(
  code: string,
  language: Language = DEFAULT_LANGUAGE
): Record<string, IdentifierRole> {
  // No prototype: keyed by identifier, and `__proto__` is an identifier.
  const roles: Record<string, IdentifierRole> = Object.create(null)
  const classKeywords = classKeywordsFor(language)
  const fnKeywords = fnKeywordsFor(language)
  const bump = (name: string, role: IdentifierRole): void => {
    const current = roles[name]
    if (current === undefined || ROLE_PRIORITY[role] > ROLE_PRIORITY[current]) {
      roles[name] = role
    }
  }

  for (const seg of tokenizeForMasking(code, language)) {
    if (seg.isComment) continue
    const regex = /(?<![a-zA-Z0-9_$])([a-zA-Z_$][a-zA-Z0-9_$]*)(?![a-zA-Z0-9_$])/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(seg.text)) !== null) {
      const name = match[1]
      if (seg.isString) {
        bump(name, seg.isModuleSpecifier ? 'package' : 'string')
        continue
      }
      if (isKeyword(name, language)) continue
      const prevWord = precedingWord(seg.text, match.index)
      if (prevWord !== undefined && classKeywords.has(prevWord)) {
        bump(name, 'class')
      } else if (
        (prevWord !== undefined && fnKeywords.has(prevWord)) ||
        isCallParen(seg.text, regex.lastIndex)
      ) {
        bump(name, 'function')
      } else if (/^[A-Z]/.test(name) && /[a-z]/.test(name)) {
        bump(name, 'class') // PascalCase fallback
      } else {
        bump(name, 'variable')
      }
    }
  }
  return roles
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Matches our placeholder shapes: __P1__, __CLS__2, __APIKEY__3, __API_KEY__7,
 *  and bases without a trailing number (__DEV__). Skipped during extraction so
 *  already-anonymized code is never re-masked. */
const PLACEHOLDER_TOKEN = /^__[A-Z][A-Z0-9_]*__\d*$/

/** Whether a token is one of our placeholders.
 *
 *  Exported because a symbol map read back from a `.veilio` file is untrusted
 *  input, and the only way to check its keys are placeholders is to ask the
 *  thing that mints them. A copy of this pattern elsewhere would drift, and the
 *  shape has to keep admitting the legacy `__P1__` style or importing an old
 *  map would fail.
 *
 *  The requirement for an uppercase first character does double duty: it refuses
 *  `__proto__`, `constructor` and `prototype`, so a map validated with this
 *  cannot carry a prototype-pollution key. */
export function isPlaceholder(token: string): boolean {
  return PLACEHOLDER_TOKEN.test(token)
}

/**
 * Extract qualifying identifiers from source code, sorted longest-first.
 * Filters out keywords, ALL_CAPS constants, placeholder-shaped tokens, and names ≤ 2 chars.
 * `language` selects the keyword set; it defaults to TypeScript so standalone
 * callers keep prior behavior.
 */
export function extractIdentifiers(code: string, language: Language = DEFAULT_LANGUAGE): string[] {
  const seen = new Set<string>()
  // Blank out comments first so their prose words are never extracted; strings
  // are left intact (identifiers in them are masked on purpose).
  const scannable = blankComments(code, language)
  // `\b` doesn't treat `$` as a word char, so use explicit negative look-around
  // to capture identifiers like `$myStore` while avoiding partial matches.
  const regex = /(?<![a-zA-Z0-9_$])([a-zA-Z_$][a-zA-Z0-9_$]*)(?![a-zA-Z0-9_$])/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(scannable)) !== null) {
    const name = match[1]
    if (
      name.length > 2 &&
      !isKeyword(name, language) &&
      !/^[A-Z][A-Z0-9_]*$/.test(name) &&
      !PLACEHOLDER_TOKEN.test(name)
    ) {
      seen.add(name)
    }
  }

  return Array.from(seen).sort((a, b) => b.length - a.length)
}

function isRunnableRule(r: CustomRuleReplace | CustomRuleWhitelist): boolean {
  return r.type !== 'replace' || !isEngineBase(r.placeholder)
}

// Custom-rule patterns run on the engine's linear-time matcher, never on
// RegExp: a teammate's pattern cannot freeze the tool applying it (spec 065).
// Compiled once per budget (one anonymize call, or what a caller shares one
// budget across), and the compile is charged to it (spec 085 L8). No cap and
// no clear: at most MAX_RULES patterns per call, so the cost cannot step.
const ruleMatchers = new WeakMap<RuleBudget, Map<string, RuleMatcher | null>>()
/** Rules one call applies, at most; past it the call's rules stop (rulesStopped). */
const MAX_RULES = 1000

function safeMatch(pattern: string, name: string, budget: RuleBudget): boolean {
  let cache = ruleMatchers.get(budget)
  if (!cache) ruleMatchers.set(budget, (cache = new Map()))
  let m = cache.get(pattern)
  if (m === undefined) {
    m = compileRulePattern(pattern, budget)
    cache.set(pattern, m)
  }
  if (m === null) return false
  try {
    return m.test(name, budget)
  } catch {
    return false // never thrown on purpose; no match is the safe direction
  }
}

/** The next placeholder of a base. */
type Mint = (base: string) => string

/** Every new number, at all four mint sites (role, replace rule, regulated
 *  value, manual mark), comes from here. Without `team`: above the highest of
 *  the base. With it (spec 066 R3): inside the base's block while it has a
 *  number left, else from the checkout's local family - never above the map,
 *  which is where the next teammate's block starts. Inside the block it
 *  continues above the highest number used inside it (usedInBlock). */
function minter(
  counters: Record<string, number>,
  team: AnonymizeOptions['team'],
  taken: Set<string>
): Mint {
  // The highest number used inside each base's block, found once per base.
  const inBlock: Record<string, number> = {}
  return (base) => {
    if (team) {
      // A block is trusted only while sane: whole, in order, at most 1e8
      // (security audit) - past that, the name is numbered locally.
      const given = Object.hasOwn(team.blocks, base) ? team.blocks[base] : undefined
      const block = isSaneBlock(given) ? given : undefined
      // Security audit (round 4): only numbers inside the block count, so a
      // teammate's planted __VAR__60000 cannot push every name past the block.
      if (block && !Object.hasOwn(inBlock, base)) inBlock[base] = usedInBlock(taken, base, block)
      let n = block ? inBlock[base] + 1 : NaN
      while (block && n <= block.end && taken.has(`${base}${n}`)) n++
      if (block && n <= block.end) {
        inBlock[base] = n
        counters[base] = Math.max(counters[base] ?? 0, n)
        taken.add(`${base}${n}`)
        return `${base}${n}`
      }
      base = localBaseOf(base, team.tag)
    }
    let n = (counters[base] ?? 0) + 1
    while (taken.has(`${base}${n}`)) n++
    // Never past the cap (Cloud 450a93ce): the lowest number nothing holds.
    if (n > MAX_PLACEHOLDER_NUMBER) for (n = 1; taken.has(`${base}${n}`);) n++
    counters[base] = n
    taken.add(`${base}${n}`)
    return `${base}${n}`
  }
}

const ANONYMIZE_OPTIONS = optionKeys<AnonymizeOptions>({
  existingMap: true,
  rules: true,
  manual: true,
  language: true,
  secrets: true,
  path: true,
  root: true,
  fileKind: true,
  team: true,
  ruleBudget: true,
})
const RESTORE_OPTIONS = optionKeys<RestoreOptions>({ strip: true })

/** `map` without the entries whose real value is a credential: one that is a
 *  credential on its own, or one the rules found in the text being masked, in
 *  any mode and context (round 3 of the review of #166, finding 1). */
function withoutCredentials(map: SymbolMap, found: ReadonlySet<string>): SymbolMap {
  let out: SymbolMap | null = null
  for (const [placeholder, real] of Object.entries(map)) {
    if (!found.has(real) && credentialSpans(real).length === 0) continue
    out ??= { ...map }
    delete out[placeholder]
  }
  return out ?? map
}

// Well-known default names that are also ordinary names in the same files (an
// image, a scheme, a host, a user, a database). Only these get the
// non-secret-position exemption. 1.12.1 review.
const DEFAULT_WORDS: ReadonlySet<string> = new Set([
  'postgres',
  'root',
  'admin',
  'mysql',
  'sa',
  'guest',
  'test',
  'user',
  'password',
  'changeme',
  'secret',
  'demo',
])

// Common weak passwords. They are only matched as whole words, so `passport`
// and `compass` stay whole, but no position exempts them: wherever one stands
// as a word it is redacted (review of #172). Lower case: the lookup
// lower-cases the value.
const WEAK_PASSWORDS: ReadonlySet<string> = new Set([
  'pass',
  'pwd',
  'passw0rd',
  'password1',
  '1234',
  '12345',
  '123456',
  '12345678',
  'qwerty',
  'letmein',
  'welcome',
  'abc123',
  'p@ssw0rd',
])

/**
 * Whether the occurrence of `word` at `at` stands where it cannot be a secret:
 * an image name (`image: postgres`), a URL scheme (`postgres://`), a URL user
 * (`://postgres:` or `://postgres@`), a URL host (`@postgres:5432`, see
 * `urlHost`), a user field (`user: postgres`,
 * `POSTGRES_USER=postgres`), or a compose service name (a key on its own
 * line, or an item of a list such as `depends_on`).
 */
function nonSecretPosition(text: string, at: number, word: string): boolean {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  const lineEnd = text.indexOf('\n', at)
  const before = text.slice(Math.max(lineStart, at - 200), at)
  const after = text.slice(at + word.length, at + word.length + 3)
  const rest = text.slice(at + word.length, lineEnd < 0 ? text.length : lineEnd)
  return (
    /\bimage\s*:\s*["']?$/i.test(before) ||
    after === '://' ||
    (/:\/\/$/.test(before) && /^[:@]/.test(after)) ||
    urlHost(text, at, word) ||
    /(?:\b|_)user(?:name)?["']?\s*[:=]\s*["']?$/i.test(before) ||
    (/^\s*(?:-\s*)?$/.test(before.slice(before.lastIndexOf('\n') + 1)) && /^:?\s*$/.test(rest))
  )
}

/**
 * Whether `word` at `at` is the host of a URL: the authority after `://` is
 * read up to its first `/`, whitespace or quote, and the host is what follows
 * the LAST `@` in it - so `://u:pw@x@postgres` is read the way a URL parser
 * reads it, never by a nearby `@`.
 */
function urlHost(text: string, at: number, word: string): boolean {
  const scheme = text.lastIndexOf('://', at)
  if (scheme < 0) return false
  const from = scheme + 3
  const stop = text.slice(from).search(/[/\s"'?#]/)
  const authority = text.slice(from, stop < 0 ? text.length : from + stop)
  if (at < from || at + word.length > from + authority.length) return false
  const hostStart = from + authority.lastIndexOf('@') + 1
  const hostEnd = hostStart + authority.slice(hostStart - from).search(/:|$/)
  return at === hostStart && at + word.length === hostEnd
}

/**
 * The text with every other occurrence of a destroyed credential replaced by
 * a redaction token, so a password used again - in a string, a URL, inside a
 * longer name - is never shown (1.12.1 security reviews).
 *
 * Every occurrence of every value is found on its own, so credentials that
 * overlap or nest are all seen. A value of 4 or more characters counts
 * wherever it stands; a shorter one, and a well-known default word, only as a
 * whole word - and a default word in a position that is structurally not a
 * secret (`nonSecretPosition`) stays as written. Overlapping and adjacent
 * occurrences are merged, and each merged span is replaced once: by the
 * token of the credential that covers it whole, or, where several distinct
 * credentials meet, by a new generic token that stands for none of them. No
 * character of any of them is left between two tokens.
 */
function spreadRedactions(
  text: string,
  tokens: ReadonlyMap<string, string>,
  known: ReadonlySet<string>
): string {
  type Hit = { start: number; end: number; value: string }
  const hits: Hit[] = []
  // Placeholders already in the text are never split - but only real ones: a
  // redaction token this call minted, or a key of the map given (never one
  // recognised by its shape alone). Anything
  // else that merely looks like a placeholder is an ordinary name and is
  // redacted whole when it holds a credential (fail closed; 1.12.1 review).
  // Precomputed once, so the pass stays linear however many occurrences
  // there are: which placeholder (if any) covers each character, and where
  // the run of identifier characters around each character starts and ends.
  const inToken = new Uint8Array(text.length)
  for (const m of text.matchAll(new RegExp(PLACEHOLDER_SCAN))) {
    if (!known.has(m[0])) continue
    inToken.fill(1, m.index, m.index + m[0].length)
  }
  // Running count of placeholder characters: a span holds one when the
  // count rises across it, in constant time.
  const tokenChars = new Int32Array(text.length + 1)
  for (let i = 0; i < text.length; i++) tokenChars[i + 1] = tokenChars[i] + inToken[i]
  const runStart = new Int32Array(text.length + 1)
  const runEnd = new Int32Array(text.length + 1)
  for (let i = 0; i < text.length; i++) {
    runStart[i] = i > 0 && IDENT_CHAR.test(text[i - 1]) ? runStart[i - 1] : i
  }
  runEnd[text.length] = text.length
  for (let i = text.length - 1; i >= 0; i--) {
    runEnd[i] = IDENT_CHAR.test(text[i]) ? runEnd[i + 1] : i
  }
  for (const value of tokens.keys()) {
    const lower = value.toLowerCase()
    const isDefault = DEFAULT_WORDS.has(lower)
    const wholeWord = value.length < 4 || isDefault || WEAK_PASSWORDS.has(lower)
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
      const end = at + value.length
      if (wholeWord && (IDENT_CHAR.test(text[at - 1] ?? '') || IDENT_CHAR.test(text[end] ?? ''))) {
        continue
      }
      if (isDefault && nonSecretPosition(text, at, value)) continue
      // A redaction never starts or ends inside a name: an occurrence that
      // touches identifier characters takes the whole name, which is then
      // redacted, not masked - a name holding a credential cannot be mapped
      // without putting part of it in the map (1.12.1 review).
      const start = IDENT_CHAR.test(text[at]) ? runStart[at] : at
      const stop = end > at && IDENT_CHAR.test(text[end - 1]) ? runEnd[end - 1] : end
      if (tokenChars[stop] - tokenChars[start] > 0) continue
      hits.push({ start, end: stop, value: start === at && stop === end ? value : '' })
    }
  }
  if (hits.length === 0) return text
  // Longest first; on an equal span, the hit that is a whole credential.
  hits.sort(
    (x, y) => x.start - y.start || y.end - x.end || Number(y.value !== '') - Number(x.value !== '')
  )
  // Merged in one sweep, carrying each group's end, so a text of many
  // overlapping occurrences stays linear after the sort.
  const groups: { start: number; end: number; whole?: Hit }[] = []
  for (const hit of hits) {
    const last = groups[groups.length - 1]
    if (last !== undefined && hit.start <= last.end) {
      if (hit.end > last.end) {
        last.end = hit.end
        last.whole = undefined
      }
    } else {
      // Sorted by start, then longest first: the first hit of a group is the
      // only one that can cover it whole.
      groups.push({ start: hit.start, end: hit.end, whole: hit })
    }
  }
  let generic = highestRedaction(text, 'CREDENTIAL')
  const genericFor = new Map<string, string>()
  let out = ''
  let at = 0
  for (const group of groups) {
    let token = group.whole !== undefined ? tokens.get(group.whole.value) : undefined
    if (token === undefined) {
      const span = text.slice(group.start, group.end)
      token = genericFor.get(span)
      if (token === undefined) {
        token = `__REDACTED_CREDENTIAL_${++generic}__`
        genericFor.set(span, token)
      }
    }
    out += text.slice(at, group.start) + token
    at = group.end
  }
  return out + text.slice(at)
}

/** A character of an identifier, for whole-word matching. */
const IDENT_CHAR = /[A-Za-z0-9_$]/

/** The highest n of the `__REDACTED_<base>_n__` tokens in `text`, so a new
 *  token never repeats one already there. */
function highestRedaction(text: string, base: string): number {
  let highest = 0
  for (const m of text.matchAll(new RegExp(`__REDACTED_${base}_(\\d+)__`, 'g'))) {
    highest = Math.max(highest, Number(m[1]))
  }
  return highest
}

/** Whether [start, end) overlaps any of `spans`. */
function overlapsAny(spans: readonly (readonly [number, number])[], start: number, end: number) {
  return spans.some(([a, b]) => start < b && a < end)
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const WORDS = /[A-Za-z_$][\w$]*/g

/** The grammar values are read by: the file's kind; a file in a language
 *  the engine reads, a language the caller names, or text that reads as
 *  code, is code. A `text` file (`.md`, `.txt`, `.tfvars`, `.bat`)
 *  or pasted text no language claims has no grammar of its own, and every
 *  value grammar applies (security review, round 4). */
/** Code whose language is only guessed: no path, no kind, no language named. */
function guessedCode(opts: Pick<AnonymizeOptions, 'fileKind' | 'path' | 'language'>): boolean {
  return !opts.fileKind && !opts.path && (opts.language ?? 'auto') === 'auto'
}

function valueKind(
  code: string,
  opts: Pick<AnonymizeOptions, 'fileKind' | 'path' | 'language'>
): ValueGrammar | 'code' | undefined {
  const kind = opts.fileKind ?? (opts.path ? fileKindOf(opts.path) : undefined)
  if (kind) return kind === 'text' ? undefined : kind
  // A path of no kind is code, unless nothing in it reads as code: a `.ts`
  // holding configuration text keeps every grammar.
  return (opts.language ?? 'auto') !== 'auto' || !guessLanguage(code).fallback ? 'code' : undefined
}

/** Where `code` holds values, as `anonymize` reads them (security review,
 *  round 3): an ordinary word there is masked, and a value under a
 *  credential key is redacted. */
export function valuePositions(
  code: string,
  opts: Pick<AnonymizeOptions, 'fileKind' | 'path' | 'language'> = {}
): ValueSpan[] {
  const kind = valueKind(code, opts)
  const language = describeLanguage(code, opts.language).language
  return valuesIn(code, language, kind, guessedCode(opts))
}

/** `detectSecrets`, and every credential value `anonymize` would redact that
 *  its rules do not report (security review, round 4): `password:
 *  Summer2024!` in text of no kind is reported, never passed over. */
export function detectCredentials(
  code: string,
  options: ScanOptions & Pick<AnonymizeOptions, 'language'> = {}
): SecretFinding[] {
  const { language, ...scan } = options
  const found = detectSecrets(code, scan)
  const spans = credentialSpans(code, scan)
  const starts = [0]
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1)
  for (const v of credentialsAmong(valuePositions(code, { ...scan, language }))) {
    if (spans.some((s) => s.start < v.end && v.start < s.end)) continue
    let line = 0
    while (line + 1 < starts.length && starts[line + 1]! <= v.start) line++
    found.push({
      type: 'password-assignment',
      severity: 'medium',
      label: 'Value of a credential-named key',
      line: line + 1,
      column: v.start - starts[line]! + 1,
      length: v.value.length,
      preview: previewSecret(v.value),
      redacted: false,
      disposition: 'report',
    })
  }
  return found
}

/** The value positions in `text` (ordinaryWords.ts), with the tokenizer's
 *  string literals: contents only, a module specifier as a path. */
function valuesIn(
  text: string,
  language: Language,
  kind: ValueGrammar | 'code' | undefined,
  net = false
): ValueSpan[] {
  const strings: { start: number; end: number; module?: boolean }[] = []
  let at = 0
  for (const s of tokenizeForMasking(text, language)) {
    if (s.isString) {
      const closed = s.text.length > 1 && s.text.endsWith(s.text[0]!)
      const end = at + s.text.length - (closed ? 1 : 0)
      strings.push({ start: at + 1, end, ...(s.isModuleSpecifier ? { module: true } : {}) })
    }
    at += s.text.length
  }
  return valueSpans(text, { strings, kind, language, net })
}

/** Spans as sorted, disjoint ranges, for `covers`. */
function mergedRanges(spans: readonly { start: number; end: number }[]): [number, number][] {
  const out: [number, number][] = []
  for (const { start, end } of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else out.push([start, end])
  }
  return out
}

/** Whether `[start, end)` overlaps one of `ranges` (sorted, disjoint), by
 *  binary search: a file holds thousands of strings. */
function covers(ranges: readonly [number, number][], start: number, end: number): boolean {
  let lo = 0
  let hi = ranges.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ranges[mid]![1] <= start) lo = mid + 1
    else hi = mid
  }
  return lo < ranges.length && ranges[lo]![0] < end
}

/**
 * Options, or the positional existing map, decided by the keys.
 *
 * It used to be a guess: an object naming none of four option keys and holding
 * only strings was a map. So a removed option (`{ style: 'plain' }`) or a typo
 * (`{ secret: 'off' }`) was stored in the map without a word, and reached Cloud
 * with it. Now an object whose keys are all placeholders is a map, one whose
 * keys are all option names is options, and anything else throws.
 */
function resolveAnonymizeOptions(
  options: AnonymizeOptions | SymbolMap | undefined | null
): AnonymizeOptions {
  if (options === undefined || options === null) return {}
  assertObject('anonymize', options)
  const keys = Object.keys(options)
  if (keys.length === 0) return {}
  if (keys.every(isPlaceholder)) return { existingMap: options as SymbolMap }
  const unknown = unknownKeys(options, ANONYMIZE_OPTIONS)
  if (unknown.length === 0) return options as AnonymizeOptions
  const stray = unknown.filter((key) => !isPlaceholder(key))
  if (stray.length > 0) throw unknownOptionError('anonymize', stray, ANONYMIZE_OPTIONS)
  throw new TypeError(
    `anonymize: options cannot also hold map placeholders (${unknown.map((k) => `'${k}'`).join(', ')}). Pass the map as { existingMap }.`
  )
}

/**
 * Anonymize source code, replacing real identifiers with role-typed
 * placeholders (__CLS__1, __FN__2, ...). Pass an existing map to continue
 * numbering from a previous session.
 *
 * Custom rules:
 * - Whitelist rules (type='whitelist'): identifiers matching the pattern are
 *   left alone, no placeholder assigned.
 * - Replace rules (type='replace'): identifiers matching the pattern get a
 *   named placeholder (e.g., __APIKEY__1, __APIKEY__2) instead of a role base.
 * Precedence: whitelist → replace (first match by sort_order) → default.
 *
 * Credentials are handled before identifier masking. Under the default
 * `secrets: 'redact'` policy, critical/high findings are replaced with
 * `__REDACTED_*__` tokens that are never written to the map — so `restore()`
 * cannot bring a live key back, and a synced map can never carry one.
 */
export function anonymize(code: string, options?: AnonymizeOptions): AnonymizeResult
/**
 * @deprecated Pass the map as `{ existingMap }`. The positional map form is
 * kept for compatibility and is removed in the next major version.
 */
export function anonymize(code: string, existingMap: SymbolMap): AnonymizeResult
export function anonymize(
  code: string,
  options: AnonymizeOptions | SymbolMap = {}
): AnonymizeResult {
  // Unknown keys throw; see resolveAnonymizeOptions.
  const opts = resolveAnonymizeOptions(options)
  if (opts.team !== undefined && !isLocalTag(opts.team?.tag))
    throw new TypeError(
      `anonymize: team.tag names the checkout, six of A-Z0-9 - got ${JSON.stringify(opts.team?.tag)}`
    )
  const where = { path: opts.path, root: opts.root, fileKind: opts.fileKind }
  // Every credential in the text as given, whatever the policy.
  const found = credentialSpans(code, where)
  // A credential never goes into the map, in any `secrets` mode (founder
  // decision 2026-10-26): an entry an older map holds for one is dropped.
  const givenMap = opts.existingMap ?? {}
  const existingMap = withoutCredentials(
    givenMap,
    // An ambiguous word an older map already holds keeps its entry: it was
    // mapped as a name, and the guard relies on it round-tripping.
    new Set(found.filter((f) => !f.ambiguous).map((f) => code.slice(f.start, f.end)))
  )
  // Spec 065: a rule the server could once refuse is now sealed where it
  // cannot see it, so the engine skips a replace rule under an engine base,
  // whoever sealed it. A pattern its matcher cannot run never matches
  // (safeMatch), so it needs no filter here.
  const rules = (opts.rules ?? []).filter(isRunnableRule)
  // One allowance of matching steps for every rule and name in this call
  // (security audit); once spent, rule tests answer no match.
  const budget = opts.ruleBudget ?? ruleBudget()
  // A rule set past the cap is not applied at all: every name masked as usual.
  if (rules.length > MAX_RULES) budget.spent = true
  const { language, fallback: languageFallback } = describeLanguage(code, opts.language)

  // Redact BEFORE extraction: a credential that reaches extractIdentifiers
  // becomes a reversible map value, which is worse than leaving it alone.
  const scan = scanSecrets(code, opts.secrets ?? 'redact', where)
  // Every other occurrence of a destroyed credential, BEFORE the manual and
  // regulated passes: they must never see, or partly rewrite, a credential's
  // later occurrence (1.12.1 review).
  const destroyed = redactionTokensOf(scan)
  // The placeholders a spread may leave whole: keys of the map given, and the
  // redaction tokens this call's scan minted.
  const trusted = new Set([...Object.keys(existingMap), ...destroyed.values()])
  const redacted = spreadRedactions(scan.code, destroyed, trusted)

  // Seed namedCounters from pre-existing placeholders (e.g. __CLS__3 → counter
  // at 3 for the __CLS__ base). Without this, a subsequent call with an
  // existingMap that already contains __CLS__1 would generate a fresh __CLS__1
  // for a new identifier and overwrite the previous mapping.
  // No prototype: keyed by real name, and a plain object answers `__proto__`
  // with Object.prototype - the name would be "already mapped" to
  // `[object Object]` and never come back.
  const reverseExisting: Record<string, string> = Object.create(null)
  const namedCounters: Record<string, number> = {}
  for (const [placeholder, realName] of Object.entries(existingMap)) {
    reverseExisting[realName] = placeholder
  }
  // Counters from the map as given, dropped entries included, so a number a
  // dropped credential held is never handed to another name (round 3,
  // finding 10): a placeholder in old output must not come back as it.
  for (const placeholder of Object.keys(givenMap)) {
    const namedMatch = placeholder.match(/^(__[A-Z][A-Z0-9_]*__)(\d+)$/)
    if (namedMatch) {
      const [, base, nStr] = namedMatch
      const n = parseInt(nStr, 10)
      if (!isNaN(n) && n <= MAX_PLACEHOLDER_NUMBER && n > (namedCounters[base] ?? 0)) {
        namedCounters[base] = n
      }
    }
  }

  // Placeholder-shaped tokens already present in the RAW code (preserved by the
  // idempotency guard in extractIdentifiers/PLACEHOLDER_TOKEN) also need to bump
  // the counters — otherwise a fresh identifier can be assigned a placeholder
  // that collides with one already in the source (comments included: restore()
  // rewrites placeholders in comments too, so a stray __CLS__1 in a comment is
  // just as much a collision risk as one in code).
  const codePlaceholderRegex = /(?<![a-zA-Z0-9_$])__[A-Z][A-Z0-9_]*__\d*(?![a-zA-Z0-9_$])/g
  let codeMatch: RegExpExecArray | null
  while ((codeMatch = codePlaceholderRegex.exec(redacted)) !== null) {
    const token = codeMatch[0]
    const namedMatch = token.match(/^(__[A-Z][A-Z0-9_]*__)(\d+)$/)
    if (namedMatch) {
      const [, base, nStr] = namedMatch
      const n = parseInt(nStr, 10)
      if (!isNaN(n) && n <= MAX_PLACEHOLDER_NUMBER && n > (namedCounters[base] ?? 0)) {
        namedCounters[base] = n
      }
    }
    // Digitless tokens (__DEV__) carry no counter to bump.
  }

  // Spec 066 (code review): placeholders a publish retired into aliases.json
  // are gone from the map but still mean their old name in text already sent.
  for (const placeholder of opts.team?.retired ?? []) {
    const m = /^(__[A-Z][A-Z0-9_]*__)(\d+)$/.exec(placeholder)
    const n = m ? Number(m[2]) : 0
    if (m && n <= MAX_PLACEHOLDER_NUMBER && n > (namedCounters[m[1]] ?? 0)) namedCounters[m[1]] = n
  }

  // Every placeholder already meaning something: a number above
  // MAX_PLACEHOLDER_NUMBER counts towards no highest, so one minted that high
  // must still step over them.
  const taken = new Set([
    ...Object.keys(givenMap),
    ...(opts.team?.retired ?? []),
    ...(redacted.match(codePlaceholderRegex) ?? []),
  ])
  const mint = minter(namedCounters, opts.team, taken)
  const map: SymbolMap = { ...existingMap }

  // Manual marks run before extraction, so the extractor sees placeholders
  // rather than the terms — and a mark therefore wins over whatever role the
  // classifier would have given the same token. Terms already in the map are
  // re-applied so a mark made in an earlier pass survives the round trip.
  const credentialValues = new Set(found.map((f) => code.slice(f.start, f.end)))
  const marked = applyManualMasks(
    redacted,
    opts.manual ?? [],
    // Refused for every credential found that is not merely possible,
    // whatever the policy: a manual mark is written to the map, and a
    // credential never is (founder decision 2026-10-26). Only an ambiguous
    // word may be marked.
    new Set(found.filter((f) => !f.ambiguous).map((f) => code.slice(f.start, f.end))),
    manualTermsIn(existingMap),
    map,
    reverseExisting,
    mint,
    language
  )

  // AFTER manual marks, on purpose — a value the author marked by hand is
  // already in `reverseExisting` and keeps its __MANUAL__n placeholder. That is
  // the entire implementation of "a manual mark wins over automatic detection";
  // swapping these two calls inverts the rule silently. Before extraction, for
  // the same reason manual marks are: the extractor then sees placeholders
  // rather than the values.
  // AFTER manual marks, on purpose — a value the author marked by hand is
  // already in `reverseExisting` and keeps its __MANUAL__n placeholder. That is
  // the entire implementation of "a manual mark wins over automatic detection";
  // swapping these two calls inverts the rule silently, which is why it has a
  // test of its own. Before extraction, for the same reason manual marks are:
  // the extractor then sees placeholders rather than the values.
  // A regulated value that is also a credential is never masked reversibly
  // (it would put the credential in the map) and never left as written (it
  // would show the PII): a destroyed one is already a token, and one left in
  // place by policy is redacted one-way here (1.12.1 review).
  const regulated = scan.regulated.filter(
    (r) => !credentialValues.has(r.value) && !destroyed.has(r.value)
  )
  let generic = highestRedaction(marked, 'CREDENTIAL')
  const keptCredentials = new Map(
    scan.regulated
      .filter((r) => credentialValues.has(r.value) && !destroyed.has(r.value))
      .map((r) => [r.value, `__REDACTED_CREDENTIAL_${++generic}__`] as const)
  )
  // Security review, round 3: under `redact` a value under a credential key
  // is a secret, replaced whole and one-way, as a detected secret is, so the
  // map never holds it - unless an older map already masks it reversibly,
  // which the guard relies on. A distinctive value is replaced wherever it
  // stands as a name too. Round 4 (founder ruling): so under `warn` and
  // `off` too - such a value is found by the credential words, not reported
  // by a rule - except where a rule found it, which those modes leave as
  // written by the user's choice.
  const kind = valueKind(code, opts)
  const net = guessedCode(opts)
  const policy = opts.secrets ?? 'redact'
  const reported =
    policy === 'redact' ? [] : credentialSpans(marked, where).map((s) => [s.start, s.end] as const)
  let unvalued: string
  {
    const mapped = new Set(Object.values(existingMap))
    const tokens = new Map<string, string>()
    let out = ''
    let at = 0
    for (const { start, end, value } of credentialsAmong(valuesIn(marked, language, kind, net))) {
      if (mapped.has(value) || destroyed.has(value) || overlapsAny(reported, start, end)) continue
      if (!tokens.has(value)) tokens.set(value, `__REDACTED_CREDENTIAL_${++generic}__`)
      out += marked.slice(at, start) + tokens.get(value)
      at = end
    }
    unvalued = out + marked.slice(at)
    for (const [value, token] of tokens)
      if (value.length > 2 && !isOrdinaryWord(value) && !isKeyword(value, language))
        unvalued = replaceWholeWord(unvalued, value, token)
    // An ordinary word stays readable as a name, but in another value it would
    // be minted into the map: there it is the credential's token too.
    const words = [...tokens].filter(([value]) => isOrdinaryWord(value))
    if (words.length > 0) {
      out = ''
      at = 0
      for (const [start, end] of mergedRanges(valuesIn(unvalued, language, kind, net))) {
        let part = unvalued.slice(start, end)
        for (const [value, token] of words) part = replaceWholeWord(part, value, token)
        out += unvalued.slice(at, start) + part
        at = end
      }
      unvalued = out + unvalued.slice(at)
    }
  }
  const source = applyRegulatedMasks(
    keptCredentials.size > 0 ? spreadRedactions(unvalued, keptCredentials, trusted) : unvalued,
    regulated,
    map,
    reverseExisting,
    mint
  )

  // What Node wrote in a pasted stack trace - V8's message wording, its own
  // frames - is neither extracted nor substituted (traces.ts). Blanked rather
  // than cut, so offsets and lines still match `source`.
  const { verbatim, unextracted } = traceSpans(source)
  // Every credential left in the text - reported under `warn`, a fixture or a
  // possible credential under `redact`, anything under `off` - is neither
  // extracted nor substituted, so no part of it reaches the map. Found again
  // in `source`, so the offsets are the ones substitution sees.
  const secretSpans = credentialSpans(source, where).map((s) => [s.start, s.end] as const)
  // Every value position but a path's: an ordinary word there is masked.
  const valued = valuesIn(source, language, kind, net).filter((s) => !s.path)
  const values = mergedRanges(valued)
  // A name the existing map already holds may still be substituted inside one:
  // that writes nothing new, and the guard relies on it for a plain word
  // (`client_secret: "disabled"`) its map already masks.
  const alreadyMapped = new Set(Object.values(existingMap))
  // Values from the text as given too: under `redact` a destroyed credential
  // is gone from `source`, and its value must not enter the map as a name
  // written elsewhere either.
  // Credentials found in the text as given (an ambiguous single word is not
  // one). A name exactly equal to one the scan destroyed is replaced by that
  // credential's own redaction token: neither shown to the model nor written
  // to the map. Where the credential is left in the text by design (`warn`,
  // `off`, a fixture in a test file) the equal name is left as written too -
  // it shows the model nothing the credential beside it does not, and
  // destroying it would corrupt code the user asked not to change - and it
  // is still never mapped. A name that only contains or is part of a
  // credential is masked and mapped like any other (coordinator ruling,
  // round 3).
  const secretValues = new Set(found.map((f) => code.slice(f.start, f.end)))
  const scannable = blankSpans(blankSpans(source, [...verbatim, ...unextracted]), secretSpans)
  // A credential value the extractor passes over (`PASSWORD=SUNSHINE` reads as
  // a constant) is a name here all the same, where it is still in the text.
  const extractedNames = extractIdentifiers(scannable, language)
  const missed = credentialsAmong(valued)
    .filter((s) => IDENTIFIER.test(s.value) && scannable.slice(s.start, s.end) === s.value)
    .map((s) => s.value)
    .filter((v) => !extractedNames.includes(v) && !isKeyword(v, language))
  const valueWords = new Set<string>()
  for (const [start, end] of values)
    for (const [w] of scannable.slice(start, end).matchAll(WORDS)) valueWords.add(w)
  const identifiers =
    missed.length === 0
      ? extractedNames
      : [...new Set([...extractedNames, ...missed])].sort((a, b) => b.length - a.length)
  const roleOf = classifyIdentifiers(scannable, language)

  // Split rules by type, sort by sort_order ASC (lower = earlier)
  const whitelist = rules
    .filter((r): r is CustomRuleWhitelist => r.type === 'whitelist' && r.enabled)
    .sort((a, b) => a.sort_order - b.sort_order)
  const replacers = rules
    .filter((r): r is CustomRuleReplace => r.type === 'replace' && r.enabled)
    .sort((a, b) => a.sort_order - b.sort_order)

  // Track whitelisted identifiers so the substitution loop knows to skip them
  const whitelisted = new Set<string>()
  // Spec 064: ordinary words, minted only for their value positions. An older
  // map's entry for one is substituted inside a credential or a value, and
  // nowhere else.
  const ordinary = new Set<string>()

  for (const name of identifiers) {
    // 1. Whitelist: skip - checked BEFORE "already mapped". A name a team map
    //    or an earlier session already holds would otherwise stay masked for
    //    ever, whatever the rule says (found on staging, 2026-09-26). The map
    //    keeps its entry, so restore is unaffected; the text just keeps the name.
    // 0. A name that is a credential found in this text is never mapped,
    //    whatever a whitelist or an older map says. A destroyed one is already
    //    a token here (spreadRedactions); one left in the text by design, or a
    //    default word in a non-secret position, is left as written.
    // A possible credential (an ambiguous word in a credential position) is
    // never given a NEW entry; an entry the existing map already holds is
    // still used (1.12.1 review: fail closed for what is new).
    if (secretValues.has(name) && !alreadyMapped.has(name)) continue

    if (whitelist.some((r) => safeMatch(r.pattern, name, budget))) {
      whitelisted.add(name)
      continue
    }

    // Spec 064: a single common word, shared vocabulary or a toolchain's name
    // is left as written - unless a custom replace rule asks for it. Like a
    // whitelisted name, an older map's entry for it is kept (old text still
    // restores) but no longer substituted.
    // In a value position it is masked (security review, round 3): given a
    // placeholder, written there and left readable elsewhere.
    // With the budget spent, a replace rule can no longer say a word is not
    // its codename: the word is masked rather than shown.
    if (
      isOrdinaryWord(name) &&
      !replacers.some((r) => safeMatch(r.pattern, name, budget)) &&
      !(replacers.length > 0 && budget.spent)
    ) {
      ordinary.add(name)
      if (!valueWords.has(name)) continue
    }

    // Already mapped - unless it is an ordinary word the engine itself mapped
    // before a team's replace rule for it existed: the rule then gives it a
    // placeholder of its own (the old entry still restores old text). Without
    // this the engine's entry would win, and a masking that leaves ordinary
    // words readable would show the codename (code review, spec 064).
    if (
      reverseExisting[name] &&
      !(
        isRolePlaceholder(reverseExisting[name]) &&
        isOrdinaryWord(name) &&
        replacers.some((r) => safeMatch(r.pattern, name, budget))
      )
    )
      continue // already mapped

    // 2. Replace: first match wins
    const matched = replacers.find((r) => safeMatch(r.pattern, name, budget))
    if (matched) {
      const ph = mint(matched.placeholder)
      map[ph] = name
      reverseExisting[name] = ph
      continue
    }

    // 3. Default: role-typed placeholder for the identifier's strongest role.
    const ph = mint(ROLE_BASES[roleOf[name] ?? 'variable'])
    map[ph] = name
    reverseExisting[name] = ph
  }

  // Substitute in ONE pass over the text.
  //
  // The obvious loop — a full-text regex replace per identifier — is
  // O(identifiers × text) and turns quadratic on real files: a 500k-char input
  // with ~8k identifiers took ~1.2s. A single alternation of every identifier
  // visits the text once instead.
  //
  // `identifiers` is already sorted longest-first by extractIdentifiers, and
  // regex alternation prefers the earliest matching branch, so longest-first
  // semantics are preserved — `OrderService` still wins over `Service`.
  // Whitelisted identifiers are simply left out of the alternation.
  // A token at or above MAX_REGEX_ATOM cannot go in the alternation without
  // making the regex uncompilable, so it is replaced separately, after the
  // alternation runs.
  //
  // Both paths assert the same identifier boundaries, so neither can match a
  // proper substring of a longer run of identifier characters, and their order
  // does not change the output. The alternation goes first because its match
  // offsets are checked against the verbatim spans, which are offsets into the
  // untouched text; replacing an oversized token first would shift them.
  // A name in the function part of a `node:` frame was kept out of extraction,
  // so it adds nothing to the map - but if the map already holds it, it is a
  // user's name and is masked like anywhere else.
  const extracted = new Set(identifiers)
  const knownInFrames = extractIdentifiers(
    unextracted.map(([start, end]) => source.slice(start, end)).join('\n'),
    language
  ).filter(
    (n) =>
      reverseExisting[n] &&
      !extracted.has(n) &&
      !whitelist.some((r) => safeMatch(r.pattern, n, budget))
  )
  // Likewise inside a credential: only names the existing map already holds.
  const knownInSecrets = extractIdentifiers(
    secretSpans.map(([start, end]) => source.slice(start, end)).join('\n'),
    language
  ).filter(
    (n) =>
      alreadyMapped.has(n) &&
      !extracted.has(n) &&
      !whitelist.some((r) => safeMatch(r.pattern, n, budget))
  )
  const substitutable = [...new Set([...identifiers, ...knownInFrames, ...knownInSecrets])]
    .sort((a, b) => b.length - a.length)
    .filter((n) => !whitelisted.has(n) && reverseExisting[n])
  const oversized = substitutable.filter((n) => n.length >= MAX_REGEX_ATOM)
  const inAlternation = substitutable.filter((n) => n.length < MAX_REGEX_ATOM)

  const pattern =
    inAlternation.length === 0
      ? null
      : new RegExp(
          `(?<![a-zA-Z0-9_$])(?:${inAlternation.map(escapeRegex).join('|')})(?![a-zA-Z0-9_$])`,
          'g'
        )

  // `start` is the segment's offset in `source`, so a match can be checked
  // against the verbatim spans. Oversized tokens skip that check: no span
  // holds a word anywhere near MAX_REGEX_ATOM characters long.
  const substitute =
    substitutable.length === 0
      ? (text: string): string => text
      : (text: string, start: number): string => {
          let out =
            pattern === null
              ? text
              : text.replace(pattern, (m, offset: number) =>
                  inSpan(verbatim, start + offset) ||
                  (!alreadyMapped.has(m) &&
                    overlapsAny(secretSpans, start + offset, start + offset + m.length)) ||
                  (ordinary.has(m) &&
                    !overlapsAny(secretSpans, start + offset, start + offset + m.length) &&
                    !covers(values, start + offset, start + offset + m.length))
                    ? m
                    : (reverseExisting[m] ?? m)
                )
          for (const name of oversized) {
            out = replaceWholeWord(out, name, reverseExisting[name] as string)
          }
          return out
        }

  // One tokenize pass feeds both the substitution and the exposure count, so
  // the spans reported are by construction the spans left verbatim.
  const segments = tokenizeForMasking(source, language)
  let offset = 0
  const anonymized = segments
    .map((s) => {
      const start = offset
      offset += s.text.length
      return s.isComment ? s.text : substitute(s.text, start)
    })
    .join('')

  return {
    anonymized,
    map,
    identifierCount: Object.keys(map).length,
    language,
    languageFallback,
    secrets: scan.findings,
    // Measured on `source` — post-redaction and post-manual-mask — because that
    // is the text whose comments are copied into `anonymized`. Measuring the
    // raw input would keep charging for a name the user has already marked.
    comments: summarizeComments(segments),
    ...(budget.spent ? { rulesStopped: true as const } : {}),
  }
}

/** Where each JSDoc block in `text` is: a closed block comment whose `/**`
 *  opens in code - not in a string, a template or regex literal, or another
 *  comment (e69). `/**` closed at once by `/` is an empty block comment, not
 *  a JSDoc. What counts as code is a lexical guess (tokenizeForMasking's
 *  `forRestore` reading), not a parse. */
function jsdocSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  // Runs on every restore: most text has no `/**` to look for.
  if (!text.includes('/**')) return spans
  let at = 0
  for (const s of tokenizeForMasking(text, 'typescript', true)) {
    const t = s.text
    if (s.isComment && t.length >= 5 && t.startsWith('/**') && t.endsWith('*/'))
      spans.push([at, at + t.length])
    at += t.length
  }
  return spans
}

/** Strip patterns in application order — larger blocks before line-level ones,
 *  so a JSDoc block isn't half-eaten by an inline-annotation match. */
// A // item runs to the end of its line: `.*` stops at \n, \r, U+2028 and U+2029,
// where a // comment ends.
const STRIP_PATTERNS: ReadonlyArray<
  readonly [StrippedItemType, RegExp | ((text: string) => Array<[number, number]>)]
> = [
  ['jsdoc', jsdocSpans],
  ['todo', /^[ \t]*\/\/[ \t]*(TODO|FIXME|HACK|REVIEW).*/gm],
  ['step-marker', /^[ \t]*\/\/[ \t]*Step\s+\d+[:.].*/gm],
  [
    'narration',
    /^[ \t]*\/\/[ \t]*(Handle|Validate|Initialize|Process|Check|Update|Create|Delete|Get|Set|Return|Log|Send|Fetch|Load|Save|Build|Parse|Format|Convert|Calculate|Generate|Execute|Run|Start|Stop|Connect|Disconnect|Register|Authenticate|Authorize).*/gm,
  ],
  ['separator', /^[ \t]*\/\/[ \t]*[-=*]{3,}.*/gm],
  ['section-header', /^[ \t]*\/\/[ \t]*\*{2}.*\*{2}[ \t]*$/gm],
  [
    'inline-annotation',
    /^[ \t]*\/\/[ \t]*@(param|returns?|type|throws?|deprecated|see|example).*/gm,
  ],
]

/** Every category `restore` knows how to remove. */
export const STRIPPABLE_TYPES: readonly StrippedItemType[] = STRIP_PATTERNS.map(([type]) => type)

function resolveStripSet(option: RestoreOptions['strip']): ReadonlySet<StrippedItemType> {
  if (option === 'none') return new Set()
  if (option === undefined || option === 'all') return new Set(STRIPPABLE_TYPES)
  return new Set(option)
}

/**
 * Remove the wanted noise from `text`, leaving everything else as written
 * (e44). Items are found in the original text, so line numbers are the AI
 * response's own. Each later pattern sees the earlier items blanked to spaces,
 * so a `// TODO` after a removed JSDoc still starts its line. Then, line by
 * line:
 * - a line that held only stripped items goes, newline and all;
 * - an item at the start of a line takes the spaces after it, and one at the
 *   end takes the spaces before it, so no stray whitespace is left;
 * - an item inside a line leaves the spacing around it.
 * Where removed lines sat between blank lines, the gap becomes the larger of
 * the two sides, not their sum. Nothing else is touched: the writer's own
 * blank lines - Python's two between top-level definitions (PEP 8) included -
 * and whitespace stay as they were. The old version collapsed every pair of
 * blank lines file-wide to hide the gaps its stripping left.
 */
function stripNoise(
  text: string,
  wanted: ReadonlySet<StrippedItemType>
): { text: string; items: StrippedItem[] } {
  if (wanted.size === 0) return { text, items: [] }
  const starts = lineIndex(text)
  const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t'

  // owner[k] is 1 + the index of the item that removes text[k], 0 where kept.
  // Allocated on the first match only. A plain number array: it holds item ids,
  // which a Uint8Array would wrap past 255 (and typed arrays made the README
  // type check take minutes under its settings).
  let owner: number[] | null = null
  const items: StrippedItem[] = []
  /** Where each item's own text begins: its first character no earlier item took. */
  const itemStart: number[] = []
  let view = text
  for (const [type, pattern] of STRIP_PATTERNS) {
    if (!wanted.has(type)) continue
    const found: Array<[number, number]> = []
    const spans =
      typeof pattern === 'function'
        ? pattern(view)
        : Array.from(view.matchAll(pattern), (m): [number, number] => [
            m.index!,
            m.index! + m[0].length,
          ])
    for (const [start, end] of spans) {
      if (start === end) continue
      let own = start
      while (own < end && isSpace(view[own])) own++
      found.push([start, end])
      itemStart.push(own)
      // From the original text: an earlier item inside this one is shown as written.
      items.push({
        type,
        content: text.slice(own, end).trim(),
        lineNumber: positionOf(starts, own).line,
      })
    }
    if (found.length === 0) continue
    owner ??= new Array<number>(text.length).fill(0)
    const parts: string[] = []
    let at = 0
    let id = items.length - found.length
    for (const [start, end] of found) {
      id++
      for (let k = start; k < end; k++) if (owner[k] === 0) owner[k] = id
      parts.push(view.slice(at, start), view.slice(start, end).replace(/[^\n]/g, ' '))
      at = end
    }
    parts.push(view.slice(at))
    view = parts.join('')
  }
  if (owner === null) return { text, items }
  const gone = owner

  /** The leading spaces and tabs of the line holding `offset`. */
  const indentAt = (offset: number): string => {
    const from = starts[positionOf(starts, offset).line - 1]!
    let to = from
    while (to < text.length && isSpace(text[to])) to++
    return text.slice(from, to)
  }

  // The line pass. A line's '\r' is kept with its newline, never stripped.
  type Line = { body: string; eol: string; dropped: boolean; blank: boolean }
  const lines: Line[] = starts.map((start, i) => {
    const next = i + 1 < starts.length ? starts[i + 1]! - 1 : text.length
    const cr = next > start && text[next - 1] === '\r' ? 1 : 0
    const end = next - cr
    const eol = text.slice(end, i + 1 < starts.length ? next + 1 : next)
    let firstGone = -1
    let lastGone = -1
    for (let k = start; k < end; k++)
      if (gone[k] !== 0) {
        if (firstGone === -1) firstGone = k
        lastGone = k
      }
    const original = text.slice(start, end)
    if (firstGone === -1) {
      // An empty line inside a multi-line item: its newlines on both sides are the
      // item's. Holds while the only multi-line item (jsdoc) owns its newlines.
      const inside = start > 0 && gone[start - 1] !== 0 && next < text.length && gone[next] !== 0
      if (inside) return { body: '', eol, dropped: true, blank: false }
      return { body: original, eol, dropped: false, blank: /^[ \t]*$/.test(original) }
    }
    let kept = ''
    for (let k = start; k < end; k++) if (gone[k] === 0) kept += text[k]
    if (/^[ \t]*$/.test(kept)) return { body: '', eol, dropped: true, blank: false }
    let body = kept
    if (/^[ \t]*$/.test(text.slice(start, firstGone))) {
      // An item at the start takes the space after it and keeps the indent - the
      // indent of the line it began on, when it began on an earlier one.
      const began = itemStart[gone[firstGone]! - 1]!
      const indent = began < start ? indentAt(began) : text.slice(start, firstGone)
      body = indent + kept.replace(/^[ \t]+/, '')
    }
    if (/^[ \t]*$/.test(text.slice(lastGone + 1, end))) {
      // A loop, not /[ \t]+$/: that regex is quadratic on a long run of spaces.
      let to = body.length
      while (to > 0 && isSpace(body[to - 1])) to--
      body = body.slice(0, to)
    }
    return { body, eol, dropped: false, blank: false }
  })

  // A run of blank and removed lines keeps the longest stretch of the writer's
  // blank lines in it, counted once - at the start of the text, only those
  // before the first removed line; at the end, only those after the last.
  for (let i = 0; i < lines.length;) {
    if (!lines[i]!.blank && !lines[i]!.dropped) {
      i++
      continue
    }
    let j = i
    let removed = false
    while (j < lines.length && (lines[j]!.blank || lines[j]!.dropped)) {
      if (lines[j]!.dropped) removed = true
      j++
    }
    if (removed) {
      const stretches: Array<[number, number]> = []
      for (let k = i; k < j;) {
        if (lines[k]!.dropped) {
          k++
          continue
        }
        const from = k
        while (k < j && lines[k]!.blank) k++
        stretches.push([from, k])
      }
      const keep =
        j === lines.length
          ? stretches.at(-1)?.[1] === j
            ? stretches.at(-1)
            : undefined
          : i === 0
            ? stretches[0]?.[0] === 0
              ? stretches[0]
              : undefined
            : stretches.reduce<[number, number] | undefined>(
                (best, s) => (!best || s[1] - s[0] > best[1] - best[0] ? s : best),
                undefined
              )
      for (const [from, to] of stretches)
        if (from !== keep?.[0]) for (let k = from; k < to; k++) lines[k]!.dropped = true
    }
    i = j
  }

  return {
    text: lines
      .filter((l) => !l.dropped)
      .map((l) => l.body + l.eol)
      .join(''),
    items,
  }
}

/**
 * Restore an AI response: strip AI-generated noise, then swap placeholders back.
 *
 * `options.strip` selects what counts as noise. It matters most for `'jsdoc'`:
 * when the model was asked to document its output, removing the docs is
 * destroying requested work, not cleaning up after it.
 */
export function restore(
  aiResponse: string,
  map: SymbolMap,
  options: RestoreOptions = {}
): RestoreResult {
  assertKnownOptions('restore', options, RESTORE_OPTIONS)
  const strippedItems: StrippedItem[] = []
  const wanted = resolveStripSet(options.strip)
  const stripped = stripNoise(aiResponse, wanted)
  strippedItems.push(...stripped.items)
  let result = stripped.text

  // Restore placeholders in one pass, longest-first.
  //
  // Same reasoning as the substitution in anonymize: a replace per placeholder
  // is O(placeholders × text) and dominated the round trip on large inputs.
  // Sorting longest-first keeps `__CLS__10` from being eaten by `__CLS__1`,
  // since alternation prefers the earliest matching branch - but only when
  // `__CLS__10` is IN the map. When it is not (a teammate's placeholder this
  // map has never seen), `__CLS__1` matched its prefix and `__CLS__10` came
  // back as `Invoice0`: a wrong name, reported as success (found on staging,
  // 2026-09-26). A placeholder never matches with a digit after it; the token
  // is left alone and reported unresolved instead.
  const placeholders = Object.keys(map).sort((a, b) => b.length - a.length)
  const seen = new Set<string>()
  if (placeholders.length > 0) {
    const pattern = new RegExp(`(?:${placeholders.map(escapeRegex).join('|')})(?!\\d)`, 'g')
    result = result.replace(pattern, (match) => {
      seen.add(match)
      return map[match] ?? match
    })
  }

  return {
    restored: result,
    strippedCount: strippedItems.length,
    strippedItems,
    report: buildRestoreReport(map, seen, result),
  }
}

/** Compare what the map offered against what the response actually used.
 *
 *  Scans the restored text rather than the raw response: every exact match has
 *  already been substituted by then, so whatever still looks like a placeholder
 *  is by definition something the map could not account for.
 *
 *  `unresolved` uses the strict `PLACEHOLDER_SCAN` and does no fuzzy matching. A
 *  case-insensitive scan would flag every Python dunder — `__init__`, `__name__`
 *  — as a mangled placeholder, and a panel that cries wolf is worse than no
 *  panel. A re-cased `__fn__1` goes to `altered` instead (spec 029), which is
 *  anchored on the kinds the engine mints and a number, so a dunder never
 *  matches. */
function buildRestoreReport(
  map: SymbolMap,
  seen: ReadonlySet<string>,
  restored: string
): RestoreReport {
  const resolved: string[] = []
  const missing: string[] = []
  for (const key of Object.keys(map)) (seen.has(key) ? resolved : missing).push(key)

  const unresolved: string[] = []
  const already = new Set<string>()
  // Fresh instance rather than the shared one: PLACEHOLDER_SCAN is a global
  // regex, and matchAll seeds its clone from the original's lastIndex.
  for (const [token] of restored.matchAll(new RegExp(PLACEHOLDER_SCAN))) {
    if (token.startsWith(REDACTION_PREFIX) || already.has(token)) continue
    already.add(token)
    unresolved.push(token)
  }

  return { resolved, missing, unresolved, altered: alteredPlaceholders(restored, map) }
}

/** Every placeholder kind the engine mints, without its underscores. */
const MINTED_KINDS = [
  ...Object.values(ROLE_BASES),
  ...Object.values(REGULATED_BASES),
  '__MANUAL__',
].map((base) => base.replace(/_/g, ''))

/** A minted kind in any case, with one to three underscores on each side, a
 *  number, and up to three trailing underscores. Not preceded by a letter, digit
 *  or underscore, so it never starts inside a name (`tmp_fn_1`, `x__fn__1`); it
 *  may be followed by one, because a model gluing a word to a placeholder it
 *  mangled (`__cls__1Factory`) is still a placeholder nothing can restore.
 *  A local one (spec 066) is the same with `LOCAL` and its tag in front
 *  (`__local_k7q2xa_var__3`). */
const NEAR_PLACEHOLDER = new RegExp(
  `(?<![A-Za-z0-9_$])_{1,3}(?:LOCAL_{1,3}[A-Z0-9]{6}_{1,3})?(?:${MINTED_KINDS.join('|')})_{1,3}\\d+_{0,3}`,
  'gi'
)

/**
 * Placeholders whose shape the model changed - case or underscores (`__fn__1`,
 * `_FN__1`) - found in `text`, each once, in order of first appearance.
 *
 * Not placeholders to the engine, so no map can restore them and `unresolved`
 * does not see them: until spec 029 every surface passed them through without a
 * word. Anchored on the kinds the engine mints and a number, so an ordinary name
 * (`tmp_fn_1`), a dunder (`__init__`), an unknown kind (`__FOO__1`) and a
 * redacted credential never match; an exact placeholder is `resolved` or
 * `unresolved`, never this.
 *
 * Given the map, a token that is one of its real names is not altered: the
 * user's own `_str_1` was masked and restored exactly (code review - without
 * this, --strict refused correct output). `restore()` always passes it; a
 * model-introduced name of that shape, in new code, is still named.
 */
export function alteredPlaceholders(text: string, map: SymbolMap = {}): string[] {
  const realNames = new Set(Object.values(map))
  const found = new Set<string>()
  for (const [token] of text.matchAll(new RegExp(NEAR_PLACEHOLDER))) {
    if (!isPlaceholder(token) && !realNames.has(token)) found.add(token)
  }
  return [...found]
}
