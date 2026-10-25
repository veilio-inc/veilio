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

// The redaction tokens a scan writes (`__REDACTED_CREDENTIAL_1__`) and the
// guard's own for a regulated number (`__REDACTED_IBAN__`).
const REDACTION_TOKEN = /(__REDACTED_[A-Z0-9_]*?_\d+__|__REDACTED_[A-Z_]*[A-Z]__)/

/** Names replaced around redaction tokens, never across them: a token's edges
 *  are word characters, so a name written against one would not be whole. */
function replaceAround(text: string, map: SymbolMap, ctx: MaskContext): string {
  if (!text.includes('__REDACTED_')) return replaceNames(text, map, ctx)
  return text
    .split(REDACTION_TOKEN)
    .map((part, i) => (i % 2 === 1 ? part : replaceNames(part, map, ctx)))
    .join('')
}

/** The scan's redacted text, with every other occurrence of each value it
 *  destroyed removed too: a rule matches a credential in its context (after
 *  its key), and the same value elsewhere, bare, is the same secret (security
 *  review of 28414f4). Values come from the text as written; one of fewer
 *  than six characters is left to the rule, since removed everywhere it would
 *  take ordinary words with it. */
function sweep(text: string, scan: ReturnType<typeof scanSecrets>): string {
  let out = scan.code
  const destroyed = scan.findings.filter((f) => f.redacted && f.length >= 6)
  if (destroyed.length === 0) return out
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  // Numbered after the scan's own tokens, so two secrets never share one.
  let n = Math.max(
    0,
    ...[...out.matchAll(/__REDACTED_CREDENTIAL_(\d+)__/g)].map((m) => Number(m[1]))
  )
  for (const f of destroyed) {
    const start = (starts[f.line - 1] ?? 0) + f.column - 1
    const value = text.slice(start, start + f.length)
    if (out.includes(value)) out = out.split(value).join(`__REDACTED_CREDENTIAL_${++n}__`)
  }
  return out
}

export function applyMap(
  text: string,
  map: SymbolMap,
  ctx: MaskContext = NO_CONTEXT,
  options: { scanned?: boolean } = {}
): string {
  // Already scanned for credentials as written (a field the guard masked
  // once, a Read's source the engine masked): only the names the map has
  // since learned are replaced.
  if (options.scanned) return replaceAround(text, map, ctx)
  // Credentials are found in the text as written, before any name is
  // replaced, and nothing the map holds overrides what the scan finds
  // (security review of a162a37).
  const scan = scanSecrets(text, 'redact')
  let redacted = sweep(text, scan)
  // A rule can take fewer characters than the secret had, leaving a residue
  // beside its token (`__REDACTED_AWS_SECRET_1__3`). Scanning again takes the
  // token and the residue together. Only after a pass that redacted something.
  for (let pass = 0; pass < 3 && redacted !== text; pass++) {
    const again = scanSecrets(redacted, 'redact').code
    if (again === redacted) break
    redacted = again
  }
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

type ReadBack = { re: RegExp | null; names: Map<string, string> }
const readBacks = new WeakMap<SymbolMap, ReadBack>()

/** The text with the map's placeholders put back, in memory only, for the
 *  secret scan; those kept masked on purpose stay. Built once per map, exact
 *  keys longest first, so every placeholder form the map holds is read. */
function readBack(text: string, map: SymbolMap): string {
  if (!text.includes('__')) return text
  let r = readBacks.get(map)
  if (!r) {
    const names = new Map<string, string>()
    for (const [placeholder, name] of Object.entries(map))
      if (!KEPT_MASKED.some((base) => placeholder.startsWith(base))) names.set(placeholder, name)
    const keys = [...names.keys()].sort((x, y) => y.length - x.length)
    r = {
      re: keys.length ? new RegExp(`(?:${keys.map(escape).join('|')})(?![0-9])`, 'g') : null,
      names,
    }
    readBacks.set(map, r)
  }
  if (!r.re) return text
  const { names } = r
  return text.replace(r.re, (p) => names.get(p) ?? p)
}

/** Credentials still in text the guard is about to hand the model, judged on
 *  what the placeholders stand for: a placeholder can hide part of a
 *  credential (`__CLS__1!9xQz` is `Acme!9xQz`), and a long placeholder number
 *  can look like key material where the name is a plain word
 *  (`secret: "__VAR__1290"` is `"abAbab"`). The restored text is only read
 *  here, never sent. Redaction tokens stay, and are not credentials (guard
 *  follow-up d03a). */
export function survivingSecrets(text: string, map: SymbolMap = {}): string[] {
  return detectSecrets(readBack(text, map))
    .filter((f) => SECRET_DISPOSITIONS[f.type] !== 'report')
    .map((f) => f.type)
}

export function restoreArgs(
  text: string,
  map: SymbolMap
): { text: string; unresolved: string[]; altered: string[] } {
  const r = restore(text, map, { strip: 'none' })
  return { text: r.restored, unresolved: r.report.unresolved, altered: r.report.altered }
}
