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
  type CommentSyntax,
  type Language,
  type LanguageOption,
} from './languages.js'
import { detectSecrets, hasBlockingSecrets, scanSecrets } from './secrets.js'
import { PRODUCT_NAME, REDACTION_PREFIX } from './product.js'

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
    parts.push(`${base}* are project-specific identifiers (${count})`)
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
// scanner, not a full parser: a `/` always reads as division, so the rare case
// of a regex literal containing a quote (e.g. `/'/`) is not handled.
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

function tokenizeForMasking(code: string, language: Language = DEFAULT_LANGUAGE): Segment[] {
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
  const n = code.length
  while (i < n) {
    const c = code[i]

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

    const lineOpener = syntax.line.find((o) => startsWithAt(o, i))
    if (lineOpener !== undefined) {
      flush(true)
      while (i < n && code[i] !== '\n') buf += code[i++]
      flush(false)
      continue
    }

    const blockPair = syntax.block.find(([open]) => startsWithAt(open, i))
    if (blockPair !== undefined) {
      const [open, close] = blockPair
      flush(true)
      buf += open
      i += open.length
      while (i < n && !startsWithAt(close, i)) buf += code[i++]
      if (i < n) {
        buf += close
        i += close.length
      }
      flush(false)
      continue
    }

    if (syntax.quotes.includes(c)) {
      // Emit the whole string/template literal as its own tagged segment so
      // role classification can tell string words and module specifiers apart.
      // Still maskable (isComment: false); escape handling unchanged.
      flush(false)
      const isModuleSpecifier = isModuleSpecifierContext(code, i)
      let str = c
      i++
      while (i < n) {
        str += code[i]
        if (code[i] === '\\') {
          if (i + 1 < n) str += code[++i]
          i++
          continue
        }
        if (code[i] === c) {
          i++
          break
        }
        i++
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
  fromMap: readonly string[],
  map: SymbolMap,
  reverseExisting: Record<string, string>,
  namedCounters: Record<string, number>,
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
    if (hasBlockingSecrets(detectSecrets(term))) {
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
    const n = (namedCounters[MANUAL_BASE] ?? 0) + 1
    namedCounters[MANUAL_BASE] = n
    const placeholder = `${MANUAL_BASE}${n}`
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

/** Terms already masked by hand in a prior pass, recovered from the map.
 *
 *  Re-derived rather than stored alongside it: the map is the only artifact
 *  that survives a reload, a `.veilio` export and a sync, so anything kept
 *  beside it would be the thing that goes missing. */
export function manualTermsIn(map: SymbolMap): string[] {
  return Object.entries(map)
    .filter(([placeholder]) => placeholder.startsWith(MANUAL_BASE))
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
  const roles: Record<string, IdentifierRole> = {}
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

function safeMatch(pattern: string, name: string): boolean {
  try {
    return new RegExp(pattern).test(name)
  } catch {
    return false
  }
}

function isAnonymizeOptions(o: AnonymizeOptions | SymbolMap): o is AnonymizeOptions {
  return 'existingMap' in o || 'rules' in o || 'language' in o || 'secrets' in o
}

function isSymbolMap(o: AnonymizeOptions | SymbolMap): o is SymbolMap {
  for (const v of Object.values(o)) {
    if (typeof v !== 'string') return false
  }
  return true
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
export function anonymize(
  code: string,
  options: AnonymizeOptions | SymbolMap = {}
): AnonymizeResult {
  // Option-key check FIRST: an options object whose values are all strings
  // (e.g. { language: 'go' }) would otherwise be misread as a SymbolMap by the
  // positional-map check below.
  const opts: AnonymizeOptions = isAnonymizeOptions(options)
    ? options
    : isSymbolMap(options)
      ? { existingMap: options }
      : options
  const existingMap = opts.existingMap ?? {}
  const rules = opts.rules ?? []
  const { language, fallback: languageFallback } = describeLanguage(code, opts.language)

  // Redact BEFORE extraction: a credential that reaches extractIdentifiers
  // becomes a reversible map value, which is worse than leaving it alone.
  const scan = scanSecrets(code, opts.secrets ?? 'redact')
  const redacted = scan.code

  // Seed namedCounters from pre-existing placeholders (e.g. __CLS__3 → counter
  // at 3 for the __CLS__ base). Without this, a subsequent call with an
  // existingMap that already contains __CLS__1 would generate a fresh __CLS__1
  // for a new identifier and overwrite the previous mapping.
  const reverseExisting: Record<string, string> = {}
  const namedCounters: Record<string, number> = {}
  for (const [placeholder, realName] of Object.entries(existingMap)) {
    reverseExisting[realName] = placeholder
    const namedMatch = placeholder.match(/^(__[A-Z][A-Z0-9_]*__)(\d+)$/)
    if (namedMatch) {
      const [, base, nStr] = namedMatch
      const n = parseInt(nStr, 10)
      if (!isNaN(n) && n > (namedCounters[base] ?? 0)) {
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
      if (!isNaN(n) && n > (namedCounters[base] ?? 0)) {
        namedCounters[base] = n
      }
    }
    // Digitless tokens (__DEV__) carry no counter to bump.
  }

  const map: SymbolMap = { ...existingMap }

  // Manual marks run before extraction, so the extractor sees placeholders
  // rather than the terms — and a mark therefore wins over whatever role the
  // classifier would have given the same token. Terms already in the map are
  // re-applied so a mark made in an earlier pass survives the round trip.
  const source = applyManualMasks(
    redacted,
    opts.manual ?? [],
    manualTermsIn(existingMap),
    map,
    reverseExisting,
    namedCounters,
    language
  )

  const identifiers = extractIdentifiers(source, language)
  const roleOf = classifyIdentifiers(source, language)

  // Split rules by type, sort by sort_order ASC (lower = earlier)
  const whitelist = rules
    .filter((r): r is CustomRuleWhitelist => r.type === 'whitelist' && r.enabled)
    .sort((a, b) => a.sort_order - b.sort_order)
  const replacers = rules
    .filter((r): r is CustomRuleReplace => r.type === 'replace' && r.enabled)
    .sort((a, b) => a.sort_order - b.sort_order)

  // Track whitelisted identifiers so the substitution loop knows to skip them
  const whitelisted = new Set<string>()

  for (const name of identifiers) {
    if (reverseExisting[name]) continue // already mapped

    // 1. Whitelist: skip
    if (whitelist.some((r) => safeMatch(r.pattern, name))) {
      whitelisted.add(name)
      continue
    }

    // 2. Replace: first match wins
    const matched = replacers.find((r) => safeMatch(r.pattern, name))
    if (matched) {
      const n = (namedCounters[matched.placeholder] ?? 0) + 1
      namedCounters[matched.placeholder] = n
      const ph = `${matched.placeholder}${n}`
      map[ph] = name
      reverseExisting[name] = ph
      continue
    }

    // 3. Default: role-typed placeholder for the identifier's strongest role.
    const base = ROLE_BASES[roleOf[name] ?? 'variable']
    const num = (namedCounters[base] ?? 0) + 1
    namedCounters[base] = num
    const ph = `${base}${num}`
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
  // making the regex uncompilable, so it is replaced separately, before the
  // alternation runs.
  //
  // The ordering is defensive rather than load-bearing: both paths assert the
  // same identifier boundaries, so neither can match a proper substring of a
  // longer run of identifier characters, and swapping them is unobservable.
  // Oversized tokens are nonetheless the longest ones (`identifiers` is sorted
  // longest-first), so applying them first is the order that stays correct if
  // either path's boundary handling is ever relaxed.
  const substitutable = identifiers.filter((n) => !whitelisted.has(n) && reverseExisting[n])
  const oversized = substitutable.filter((n) => n.length >= MAX_REGEX_ATOM)
  const inAlternation = substitutable.filter((n) => n.length < MAX_REGEX_ATOM)

  const pattern =
    inAlternation.length === 0
      ? null
      : new RegExp(
          `(?<![a-zA-Z0-9_$])(?:${inAlternation.map(escapeRegex).join('|')})(?![a-zA-Z0-9_$])`,
          'g'
        )

  const substitute =
    substitutable.length === 0
      ? (text: string): string => text
      : (text: string): string => {
          let out = text
          for (const name of oversized) {
            out = replaceWholeWord(out, name, reverseExisting[name] as string)
          }
          return pattern === null ? out : out.replace(pattern, (m) => reverseExisting[m] ?? m)
        }

  // One tokenize pass feeds both the substitution and the exposure count, so
  // the spans reported are by construction the spans left verbatim.
  const segments = tokenizeForMasking(source, language)
  const anonymized = segments.map((s) => (s.isComment ? s.text : substitute(s.text))).join('')

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
  }
}

/** Strip patterns in application order — larger blocks before line-level ones,
 *  so a JSDoc block isn't half-eaten by an inline-annotation match. */
const STRIP_PATTERNS: ReadonlyArray<readonly [StrippedItemType, RegExp]> = [
  ['jsdoc', /\/\*\*[\s\S]*?\*\//g],
  ['todo', /^[ \t]*\/\/[ \t]*(TODO|FIXME|HACK|REVIEW)[^\n]*/gm],
  ['step-marker', /^[ \t]*\/\/[ \t]*Step\s+\d+[:.][^\n]*/gm],
  [
    'narration',
    /^[ \t]*\/\/[ \t]*(Handle|Validate|Initialize|Process|Check|Update|Create|Delete|Get|Set|Return|Log|Send|Fetch|Load|Save|Build|Parse|Format|Convert|Calculate|Generate|Execute|Run|Start|Stop|Connect|Disconnect|Register|Authenticate|Authorize)[^\n]*/gm,
  ],
  ['separator', /^[ \t]*\/\/[ \t]*[-=*]{3,}[^\n]*/gm],
  ['section-header', /^[ \t]*\/\/[ \t]*\*{2}.*\*{2}[ \t]*$/gm],
  [
    'inline-annotation',
    /^[ \t]*\/\/[ \t]*@(param|returns?|type|throws?|deprecated|see|example)[^\n]*/gm,
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
  const strippedItems: StrippedItem[] = []
  const wanted = resolveStripSet(options.strip)
  let result = aiResponse

  function strip(pattern: RegExp, type: StrippedItemType): void {
    if (!wanted.has(type)) return
    result = result.replace(pattern, (match) => {
      const before = result.slice(0, result.indexOf(match))
      const lineNumber = before.split('\n').length
      strippedItems.push({ type, content: match.trim(), lineNumber })
      return ''
    })
  }

  for (const [type, pattern] of STRIP_PATTERNS) strip(pattern, type)

  // Tidy up after stripping. Gated on whether stripping is enabled at all, not
  // on whether anything matched: `strip: 'none'` means "restore placeholders and
  // change nothing else", so it must not reformat.
  if (wanted.size > 0) {
    // Removing a comment leaves its indentation behind, so a stripped block
    // becomes a line of spaces rather than a blank line — invisible in the UI,
    // trailing whitespace in the editor it gets pasted into, and a lint error in
    // any project with no-trailing-spaces. Blanked before the run collapse below
    // so those lines can actually be collapsed.
    result = result.replace(/^[ \t]+$/gm, '')
    // Collapse 3+ consecutive blank lines to 2.
    result = result.replace(/\n{3,}/g, '\n\n')
  }

  // Restore placeholders in one pass, longest-first.
  //
  // Same reasoning as the substitution in anonymize: a replace per placeholder
  // is O(placeholders × text) and dominated the round trip on large inputs.
  // Sorting longest-first keeps `__CLS__10` from being eaten by `__CLS__1`,
  // since alternation prefers the earliest matching branch.
  const placeholders = Object.keys(map).sort((a, b) => b.length - a.length)
  const seen = new Set<string>()
  if (placeholders.length > 0) {
    const pattern = new RegExp(placeholders.map(escapeRegex).join('|'), 'g')
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
 *  Deliberately uses the strict `PLACEHOLDER_SCAN` and does no fuzzy matching. A
 *  case-insensitive scan would flag every Python dunder — `__init__`, `__name__`
 *  — as a mangled placeholder, and a panel that cries wolf is worse than no
 *  panel. A re-cased `__fn__1` therefore shows up as `missing`, not
 *  `unresolved`, which is the honest classification: we know the placeholder
 *  never came back, and we are not going to guess that the lowercase token
 *  nearby is what it became. */
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

  return { resolved, missing, unresolved }
}
