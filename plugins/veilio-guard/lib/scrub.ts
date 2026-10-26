// The engine, as the guard uses it (spec 033, research R3).
//
// scrubSource: a source file the model reads. The engine's tokenizer masks
//   every identifier, reusing the map's placeholders, and reports the new
//   entries for the map file.
// applyMap: everything else - shell output, search results, prompts,
//   reminders. Only names the map already has are replaced, and credentials
//   are removed. No entries are added: fed to the tokenizer, a log would fill
//   the map with English words. Everyday words from string literals are left.
// restoreArgs: the model's arguments, with the real names put back and nothing
//   else changed. The caller decides what an unknown placeholder means.
import {
  MANUAL_BASE,
  REDACTION_TOKENS,
  REGULATED_BASES,
  anonymize,
  detectSecrets,
  isKeyword,
  isPlaceholder,
  keepRule,
  restore,
  scanSecrets,
  SECRET_DISPOSITIONS,
} from '../vendor/engine/index.js'
import type { Language, LanguageOption } from '../vendor/engine/index.js'

export type SymbolMap = Record<string, string>

/** What masking knows about the text in hand (spec 050): its language, the
 *  project's languages, the names the project takes from outside and the names
 *  it declares, and whether the user typed it. */
export type MaskContext = {
  language: Language | 'unknown'
  projectLanguages: ReadonlySet<Language>
  external: ReadonlySet<string>
  declared: ReadonlySet<string>
  kind: 'result' | 'prompt'
}

export const NO_CONTEXT: MaskContext = {
  language: 'unknown',
  projectLanguages: new Set(),
  external: new Set(),
  declared: new Set(),
  kind: 'result',
}

export function scrubSource(
  text: string,
  map: SymbolMap,
  language: LanguageOption = 'auto',
  keep: ReadonlySet<string> = new Set()
): { text: string; additions: SymbolMap } {
  // `keep`: names left as written - a third-party package's (spec 050 R4) -
  // through the engine's own whitelist rules, matched whole.
  const rules = keepRule(keep, 'veilio-guard-keep', 'veilio-guard: third-party names')
  const result = anonymize(text, { existingMap: map, language, rules })
  const additions: SymbolMap = {}
  for (const [placeholder, name] of Object.entries(result.map)) {
    if (map[placeholder] !== name) additions[placeholder] = name
  }
  return { text: result.anonymized, additions }
}

const WORD = /[A-Za-z0-9_$]/

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// One alternation per map, longest name first, so a name inside a longer one
// is never half-replaced. Cached by the map object: the guard keeps one map
// object until it changes.
type Matcher = {
  re: RegExp | null
  byName: Map<string, string>
  /** The kinds of placeholder each name has (`__PKG__`, `__VAR__`, …). */
  kinds: Map<string, Set<string>>
}
const compiled = new WeakMap<SymbolMap, Matcher>()

function matcher(map: SymbolMap): Matcher {
  let c = compiled.get(map)
  if (!c) {
    const byName = new Map<string, string>()
    const kinds = new Map<string, Set<string>>()
    for (const [placeholder, name] of Object.entries(map)) {
      if (name === '' || everydayWord(placeholder, name)) continue
      byName.set(name, placeholder)
      const kind = /^__[A-Z]+__/.exec(placeholder)?.[0] ?? placeholder
      kinds.set(name, (kinds.get(name) ?? new Set()).add(kind))
    }
    const names = [...byName.keys()].sort((a, b) => b.length - a.length)
    c = { re: names.length ? new RegExp(names.map(escape).join('|'), 'g') : null, byName, kinds }
    compiled.set(map, c)
  }
  return c
}

// Directory names nearly every project has. One is left as written when the
// map holds it only as a path (`__PKG__`); the project's own variable `tests`
// is still masked (spec 050 R4).
const CONVENTIONAL_DIRS = new Set([
  'src',
  'lib',
  'test',
  'tests',
  '__tests__',
  'spec',
  'e2e',
  'docs',
  'scripts',
  'packages',
  'apps',
  'app',
  'cmd',
  'internal',
  'pkg',
  'dist',
  'build',
  'bin',
  'config',
  'public',
  'assets',
  'fixtures',
])

/** A keyword or built-in of the text's language; for text of unknown
 *  language, of every language the project uses (all ten until they are
 *  known), so that unknown text favours masking (spec 050 R3, FR-005). */
function reserved(name: string, ctx: MaskContext): boolean {
  if (ctx.language !== 'unknown') return isKeyword(name, ctx.language)
  if (ctx.projectLanguages.size === 0) return neverMasked(name)
  return [...ctx.projectLanguages].every((language) => isKeyword(name, language))
}

/** Whether a map name found at `offset` stays as written: spec 050
 *  data-model, Exemptions, in order. The project's declared names win over
 *  every exemption but a keyword of the text's own language. */
function leftAsWritten(
  name: string,
  text: string,
  offset: number,
  m: Matcher,
  ctx: MaskContext
): boolean {
  if (reserved(name, ctx)) return true
  if (ctx.declared.has(name)) return false
  if (ctx.external.has(name)) return true
  const kinds = m.kinds.get(name)
  if (CONVENTIONAL_DIRS.has(name) && kinds && [...kinds].every((k) => k === '__PKG__')) return true
  return ctx.kind === 'prompt' && isFlag(name, text, offset, kinds)
}

/** A command-line flag in what the user typed (`run it --verbose`): a dash or
 *  two after a space or the start, a flag-shaped word, and a word the map
 *  holds only as a path or a string, never as code. Negation (`-balance`), a
 *  decrement (`--counter`), a diff's removed line and `<!--x-->` are not flags
 *  (review of 9355866). */
function isFlag(
  name: string,
  text: string,
  offset: number,
  kinds: Set<string> | undefined
): boolean {
  // Only dashes directly before the name: `- verbose`, a bullet, is not a flag
  // (security review of 4446710).
  const dashes = text[offset - 1] === '-' ? (text[offset - 2] === '-' ? 2 : 1) : 0
  if (dashes === 0) return false
  const before = text[offset - dashes - 1]
  if (before !== undefined && !/\s/.test(before)) return false
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) return false
  return !!kinds && [...kinds].every((k) => k === '__PKG__' || k === '__STR__')
}

// A lowercase word from a string literal (`the`, `keep`) is masked where the
// engine finds it, inside a literal in a source file. In output and prompts it
// is mostly English, and masking it there turns a git log into placeholders.
// A capitalised one (`Contoso`) or one shaped like a name (`customer_refunds`,
// `apiV2`) is still masked everywhere. A lowercase one-word name in a literal
// (a surname, a codename) is the cost, and COVERAGE.md states it. Identifiers
// are masked everywhere, so a prompt naming `reconcile` matches the code.
function everydayWord(placeholder: string, name: string): boolean {
  return placeholder.startsWith('__STR__') && /^[a-z]+$/.test(name)
}

// A name the engine keeps in every language (`length`) is never masked in a
// source file, so it is never applied either. A map built by an older engine
// may still hold it; restore still reads the old placeholder.
const LANGUAGES: readonly Language[] = [
  'typescript',
  'python',
  'go',
  'java',
  'csharp',
  'rust',
  'ruby',
  'php',
  'c',
  'sql',
]
function neverMasked(name: string): boolean {
  return LANGUAGES.every((language) => isKeyword(name, language))
}

function replaceNames(text: string, map: SymbolMap, ctx: MaskContext = NO_CONTEXT): string {
  const m = matcher(map)
  const { re, byName } = m
  if (!re) return text
  return text.replace(re, (name, offset: number) => {
    // A whole token only: `settledTotal` in `settledTotals` is another name.
    const before = text[offset - 1]
    const after = text[offset + name.length]
    if (WORD.test(name.charAt(0)) && before !== undefined && WORD.test(before)) return name
    if (WORD.test(name.charAt(name.length - 1)) && after !== undefined && WORD.test(after))
      return name
    if (leftAsWritten(name, text, offset, m, ctx)) return name
    return byName.get(name) ?? name
  })
}

// The redaction tokens the engine treats as its own (a scan's
// `__REDACTED_CREDENTIAL_1__`, the guard's `__REDACTED_IBAN__`), exactly.
const REDACTION_TOKEN = new RegExp(`(${REDACTION_TOKENS.source})`)
// What a rule left of a secret it only partly took, before the value's
// closing quote (`__REDACTED_AWS_SECRET_1__3"`).
const KEY_CHAR = /[A-Za-z0-9+/=_-]/
const TOKENS = new RegExp(REDACTION_TOKENS.source, 'g')

/** What a rule left of a secret it only partly took, between its token and
 *  the value's closing quote (`__REDACTED_AWS_SECRET_1__3"`), removed. One
 *  cursor over the text: a run of key characters is read once, never again
 *  from inside it (security review of 839898f). */
export function dropResidue(text: string): string {
  if (!text.includes('__REDACTED_')) return text
  let out = ''
  let at = 0
  let cursor = 0
  for (const m of text.matchAll(TOKENS)) {
    const end = m.index + m[0].length
    if (end <= cursor) continue
    let to = end
    while (to < text.length && KEY_CHAR.test(text[to]!)) to++
    cursor = to
    if (to > end && /["'`]/.test(text[to] ?? '')) {
      out += text.slice(at, end)
      at = to
    }
  }
  return out + text.slice(at)
}

/** `fn` on each piece of `text` between redaction tokens, never across one:
 *  a token's edges are word characters, so a name written against one would
 *  not be whole. */
function aroundTokens(text: string, fn: (part: string) => string): string {
  if (!text.includes('__REDACTED_')) return fn(text)
  return text
    .split(REDACTION_TOKEN)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('')
}

function replaceAround(text: string, map: SymbolMap, ctx: MaskContext): string {
  return aroundTokens(dropResidue(text), (part) => replaceNames(part, map, ctx))
}

/** A credential's value worth removing wherever it appears again: six
 *  characters or more and key material by its own look, at least two kinds of
 *  character (letters and digits, two cases, a symbol). A plain word such as
 *  `postgres`, a structural rule's finding in a docker-compose URL, is
 *  removed where its rule finds it and nowhere else: learned, it ate every
 *  `import postgres` after it (review of 99325ba). */
function credentialLike(value: string): boolean {
  if (value.length < 6) return false
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((k) => k.test(value)).length
  return kinds >= 2
}

/** Where each destroyed finding stands in `text`: its start, the end of what
 *  the rule took, and the end of the key characters that run on after it (a
 *  rule may take only part of a longer key). */
function destroyedSpans(
  text: string,
  scan: ReturnType<typeof scanSecrets>
): { start: number; matched: number; end: number; type: string }[] {
  const found = scan.findings.filter((f) => f.redacted)
  if (found.length === 0) return []
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return found.map((f) => {
    const start = (starts[f.line - 1] ?? 0) + f.column - 1
    let end = start + f.length
    while (end < text.length && KEY_CHAR.test(text[end]!)) end++
    return { start, matched: start + f.length, end, type: f.type }
  })
}

export type ScanResult = ReturnType<typeof scanSecrets>

// Rules that judge by shape and context rather than a provider's format: only
// their findings defer to a value the map already masks reversibly. A
// provider-format finding (an AWS or GitHub key, a private key block, a JWT)
// always wins (security review of 933156e).
const HEURISTIC = new Set([
  'password-assignment',
  'high-entropy-string',
  'connection-string',
  'basic-auth',
  'bearer-token',
  'possible-credential',
])

/** Whether `text` holds a provider-format key (any rule but those that
 *  judge by shape): a value no restoration may put back. */
export function holdsProviderKey(text: string): boolean {
  return providerKeys(text).length > 0
}

/** The provider-format keys in `text`, one entry per occurrence. */
export function providerKeys(text: string): string[] {
  const found = detectSecrets(text).filter(
    (f) => !HEURISTIC.has(f.type) && SECRET_DISPOSITIONS[f.type] !== 'report'
  )
  if (found.length === 0) return []
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return found.map((f) => {
    const start = (starts[f.line - 1] ?? 0) + f.column - 1
    return text.slice(start, start + f.length)
  })
}

/** Whether `after` holds a provider-format key `before` does not, or more
 *  copies of one: compared by value, so a key already written cannot cover
 *  for a different one a restoration puts back (review of 5f11069). */
export function addsProviderKey(before: string, after: string): boolean {
  const had = new Map<string, number>()
  for (const k of providerKeys(before)) had.set(k, (had.get(k) ?? 0) + 1)
  for (const k of providerKeys(after)) {
    const n = had.get(k) ?? 0
    if (n === 0) return true
    had.set(k, n - 1)
  }
  return false
}

const restorable = new WeakMap<SymbolMap, SymbolMap>()
/** The map less the entries whose value is a provider-format key: those are
 *  quarantined, never restored, whatever session wrote them (security review
 *  of 2af9fca). */
export function restorableMap(map: SymbolMap): SymbolMap {
  let out = restorable.get(map)
  if (!out) {
    out = {}
    for (const [placeholder, name] of Object.entries(map))
      if (!holdsProviderKey(name)) out[placeholder] = name
    restorable.set(map, out)
  }
  return out
}

const mapNames = new WeakMap<SymbolMap, ReadonlySet<string>>()
/** The names a map holds, which are masked reversibly and never destroyed. */
function namesOf(map: SymbolMap): ReadonlySet<string> {
  let set = mapNames.get(map)
  if (!set) mapNames.set(map, (set = new Set(Object.values(map))))
  return set
}

/** The values worth learning from a scan of `text`: what each rule took and
 *  its whole extent, when credential-like and not a name the map holds. */
function learnable(text: string, scan: ReturnType<typeof scanSecrets>, map: SymbolMap): string[] {
  const names = namesOf(map)
  const out: string[] = []
  for (const { start, matched, end, type } of destroyedSpans(text, scan)) {
    const core = text.slice(start, matched)
    if (names.has(core) && HEURISTIC.has(type)) continue
    for (const v of end > matched ? [core, text.slice(start, end)] : [core])
      if (credentialLike(v)) out.push(v)
  }
  return out
}

/** Every value the scans of a whole result destroy, so that a secret found in
 *  one string of it (a Grep line, a field) is removed from all of them
 *  (security review of 75fe4c0). */
export function destroyedValues(
  texts: readonly string[],
  map: SymbolMap = {},
  scan?: ScanResult
): string[] {
  const values = new Set<string>()
  for (const text of texts)
    for (const value of learnable(text, scan ?? scanSecrets(text, 'redact'), map)) values.add(value)
  return [...values]
}

// Past these, removing every occurrence is not attempted: the caller's
// failure path withholds the result or drops the prompt (fail closed).
const MAX_SPANS = 100_000
const MAX_VALUE = 16_384

/** The shortest shift at which `value` matches itself (its length when it
 *  never does), from the prefix function. */
function periodOf(value: string): number {
  const border = new Array<number>(value.length).fill(0)
  for (let i = 1, k = 0; i < value.length; i++) {
    while (k > 0 && value[i] !== value[k]) k = border[k - 1]!
    if (value[i] === value[k]) k++
    border[i] = k
  }
  return value.length - (border[value.length - 1] ?? 0)
}

/** The credentials a session has destroyed, held in memory only, each with
 *  one token: the same secret reads as the same token everywhere, two
 *  secrets as two (review of 8aed5e8). Numbered from 1001 so they stay apart
 *  from the tokens a single scan writes. Only credential-like values are
 *  swept from later texts; every destroyed value has a token. */
export class Destroyed {
  private tokens = new Map<string, string>()
  private sweep = new Map<string, number>()
  private list: string[] | null = []
  private next = 1001
  learn(values: readonly string[]): void {
    // Every value is kept, one too long to search for by its bounded prefix;
    // then a too-long one fails the text that holds it (the caller withholds
    // it). The others are never dropped (review of 600a53c).
    let tooLong = false
    for (const value of values) {
      const v = value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) : value
      if (v.length < value.length) tooLong = true
      if (v === '' || this.sweep.has(v)) continue
      this.tokenFor(v)
      this.sweep.set(v, periodOf(v))
      this.list = null
    }
    if (tooLong) throw new Error('a destroyed credential too long to remove safely')
  }
  /** The values swept from later texts, with each one's period. */
  get values(): string[] {
    return (this.list ??= [...this.sweep.keys()])
  }
  periodOf(value: string): number {
    return this.sweep.get(value) ?? periodOf(value)
  }
  tokenFor(value: string): string {
    let token = this.tokens.get(value)
    if (!token) this.tokens.set(value, (token = `__REDACTED_CREDENTIAL_${this.next++}__`))
    return token
  }
}

/** `text` with every occurrence of every learned value removed, inside a
 *  longer word too: a learned value is key material by its own look, and a
 *  copy of it anywhere is the secret (security review of 933156e). Nothing
 *  after it is taken: the value was learned with its whole extent, and a
 *  following identifier is not part of it. A run that keeps repeating a
 *  value's period is one span, and the search never goes back; spans of
 *  different values that overlap are merged and take the longest one's
 *  token, spans that only touch stay two. Run on text as written, before any
 *  masking, so no repeat reaches the map. */
export function redactKnown(text: string, known: Destroyed): string {
  const values = known.values
  if (values.length === 0) return text
  const spans: [number, number, string][] = []
  for (const value of values) {
    const period = known.periodOf(value)
    for (let i = text.indexOf(value); i !== -1;) {
      let j = i + value.length
      while (j < text.length && text[j] === text[j - period]) j++
      spans.push([i, j, value])
      if (spans.length > MAX_SPANS)
        throw new Error('too many occurrences of a destroyed credential to remove them safely')
      // A value that repeats at more than one shift can start again inside
      // the run and cross its end: the search resumes where that is still
      // possible, at least one period on (review of 600a53c).
      i = text.indexOf(value, Math.max(i + period, j - value.length + 1))
    }
  }
  if (spans.length === 0) return text
  spans.sort((x, y) => x[0] - y[0] || y[1] - x[1])
  const merged: [number, number, string][] = []
  for (const [start, end, value] of spans) {
    const last = merged[merged.length - 1]
    if (last && start < last[1]) {
      last[1] = Math.max(last[1], end)
      if (value.length > last[2].length) last[2] = value
    } else merged.push([start, end, value])
  }
  let result = ''
  let at = 0
  for (const [start, end, value] of merged) {
    result += text.slice(at, start) + known.tokenFor(value)
    at = end
  }
  return result + text.slice(at)
}

export function applyMap(
  text: string,
  map: SymbolMap,
  ctx: MaskContext = NO_CONTEXT,
  options: { scanned?: boolean; known?: Destroyed; scan?: ScanResult; swept?: boolean } = {}
): string {
  // Already scanned for credentials as written (a field the guard masked
  // once, a Read's source the engine masked): only the names the map has
  // since learned are replaced.
  if (options.scanned) return replaceAround(text, map, ctx)
  const known = options.known ?? new Destroyed()
  // Credentials are found in the text as written, before any name is
  // replaced (security review of a162a37). Each finding is removed where it
  // stands, with the key characters that run on after it, under its value's
  // one token; a value the map holds is a name masked reversibly, kept for
  // its placeholder and never learned (review of 99325ba).
  const scan = options.scan ?? scanSecrets(text, 'redact')
  known.learn(learnable(text, scan, map))
  const names = namesOf(map)
  let redacted = ''
  let at = 0
  for (const { start, matched, end, type } of destroyedSpans(text, scan)) {
    if (start < at) continue
    const core = text.slice(start, matched)
    if (names.has(core) && HEURISTIC.has(type)) continue
    redacted += text.slice(at, start) + known.tokenFor(core)
    at = end
  }
  redacted += text.slice(at)
  // Every credential the session has destroyed, wherever it stands as a word.
  if (!options.swept) redacted = redactKnown(redacted, known)
  let out = replaceAround(redacted, map, ctx)
  // A regulated number (an IBAN, a card, a PESEL) the map does not have yet:
  // output adds no entries, so it is removed, irreversibly.
  for (const span of scan.regulated) {
    const token = `__REDACTED_${span.type.toUpperCase().replace(/[^A-Z0-9]/g, '_')}__`
    out = out.split(span.value).join(token)
  }
  return out
}

// A name shaped like an identifier: an inner capital (`luhnValid`), an inner
// underscore (`team_layers`), or PascalCase with two humps (`BatchReconciler`).
// English almost never has these shapes, so they can be masked in output the
// tokenizer must not see (spec 050 R1). A lowercase one-word name (`settle`)
// has no shape: only the project index protects it.
const SHAPED =
  /(?<![\w$])(?:[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*[A-Za-z0-9]|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)(?![\w$])/g

// Names of the platform and the tools, which reach every project's output.
const PLATFORM = new Set([
  'AssertionError',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'JavaScript',
  'TypeScript',
  'GitHub',
  'GitLab',
  'NodeJS',
  'PowerShell',
  'macOS',
  'iOS',
  'iPhone',
])

function keywordIn(name: string, ctx: MaskContext): boolean {
  if (ctx.language !== 'unknown') return isKeyword(name, ctx.language)
  const languages = ctx.projectLanguages.size ? [...ctx.projectLanguages] : LANGUAGES
  return languages.some((language) => isKeyword(name, language))
}

/** Masks the names shaped like identifiers that are still in `text` after the
 *  map was applied, minting their placeholders through the engine so the
 *  numbering is the map's, and returns them for the map file. Not for what the
 *  user typed: a name they type that the map does not have goes as typed
 *  (spec 033 COVERAGE). */
export function maskShaped(
  text: string,
  map: SymbolMap,
  ctx: MaskContext
): { text: string; additions: SymbolMap } {
  if (ctx.kind === 'prompt') return { text, additions: {} }
  // A name written against a redaction token is masked like any other.
  if (text.includes('__REDACTED_')) {
    let working = map
    const additions: SymbolMap = {}
    const out = aroundTokens(text, (part) => {
      const r = maskShapedPart(part, working, ctx)
      if (Object.keys(r.additions).length) {
        Object.assign(additions, r.additions)
        working = { ...working, ...r.additions }
      }
      return r.text
    })
    return { text: out, additions }
  }
  return maskShapedPart(text, map, ctx)
}

function maskShapedPart(
  text: string,
  map: SymbolMap,
  ctx: MaskContext
): { text: string; additions: SymbolMap } {
  const placeholderOf = new Map(Object.entries(map).map(([p, name]) => [name, p]))
  const reused: SymbolMap = {}
  const found = new Set<string>()
  for (const [token] of text.matchAll(SHAPED)) {
    const known = placeholderOf.get(token)
    if (known) {
      reused[known] = token
      continue
    }
    if (isPlaceholder(token) || /^[A-Z0-9_]+$/.test(token)) continue
    if (PLATFORM.has(token) || ctx.external.has(token) || keywordIn(token, ctx)) continue
    found.add(token)
  }
  if (found.size === 0) return { text: replaceNames(text, reused, ctx), additions: {} }
  // Declared, so the engine mints the kind a reader expects for each shape.
  const source = [...found]
    .map((t) => (/^[A-Z]/.test(t) && !t.includes('_') ? `class ${t} {}` : `let ${t} = 0`))
    .join('\n')
  const minted = anonymize(source, { existingMap: map, language: 'typescript', secrets: 'off' }).map
  const additions: SymbolMap = {}
  for (const [placeholder, name] of Object.entries(minted))
    if (found.has(name) && map[placeholder] !== name) additions[placeholder] = name
  return { text: replaceNames(text, { ...reused, ...additions }, ctx), additions }
}

// Placeholders that stand for a value masked on purpose: a regulated number
// (`__PAN__1`) or a value the author marked by hand (`__MANUAL__1`). They stay
// masked when the last scan reads the rest back.
const KEPT_MASKED = [...Object.values(REGULATED_BASES), MANUAL_BASE].filter(
  (base): base is string => typeof base === 'string'
)

// Every placeholder form the engine writes, legacy ones included (`__P1__`):
// the same shape as its PLACEHOLDER_TOKEN, read whole.
const PLACEHOLDER_IN_TEXT = /__[A-Z][A-Z0-9_]*?__\d*/g

/** The text with the map's placeholders put back, in memory only, for the
 *  secret scan; those kept masked on purpose stay. One pass with lookups: no
 *  pattern is built per map (review of 99325ba). */
function readBack(text: string, map: SymbolMap): string {
  if (!text.includes('__')) return text
  return text.replace(PLACEHOLDER_IN_TEXT, (p) =>
    Object.hasOwn(map, p) && !KEPT_MASKED.some((base) => p.startsWith(base)) ? map[p]! : p
  )
}

/** Credentials still in text the guard is about to hand the model, judged on
 *  what the placeholders stand for: a placeholder can hide part of a
 *  credential (`__CLS__1!9xQz` is `Acme!9xQz`), and a long placeholder number
 *  can look like key material where the name is a plain word
 *  (`secret: "__VAR__1290"` is `"abAbab"`). The restored text is only read
 *  here, never sent. Redaction tokens stay, and are not credentials (guard
 *  follow-up d03a). */
export function survivingSecrets(text: string, map: SymbolMap = {}): string[] {
  const real = readBack(text, map)
  const found = detectSecrets(real).filter((f) => SECRET_DISPOSITIONS[f.type] !== 'report')
  if (found.length === 0) return []
  // A value that is one of the map's names is masked reversibly, not a
  // credential left behind (review of 99325ba).
  const names = namesOf(map)
  const starts = [0]
  for (let i = 0; i < real.length; i++) if (real[i] === '\n') starts.push(i + 1)
  return found
    .filter((f) => {
      const start = (starts[f.line - 1] ?? 0) + f.column - 1
      return !HEURISTIC.has(f.type) || !names.has(real.slice(start, start + f.length))
    })
    .map((f) => f.type)
}

export function restoreArgs(
  text: string,
  map: SymbolMap
): { text: string; unresolved: string[]; altered: string[] } {
  const r = restore(text, map, { strip: 'none' })
  return { text: r.restored, unresolved: r.report.unresolved, altered: r.report.altered }
}
