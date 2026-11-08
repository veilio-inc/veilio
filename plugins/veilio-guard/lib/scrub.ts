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
  compileRulePattern,
  credentialsAmong,
  detectSecrets,
  isKeyword,
  isLocalPlaceholder,
  isOrdinaryWord,
  isPlaceholder,
  isRolePlaceholder,
  keepRule,
  restore,
  scanSecrets,
  SECRET_DISPOSITIONS,
  shannonEntropy,
  valueSpans,
} from '../vendor/engine/index.js'
import type {
  CustomRule,
  FileKind,
  Language,
  LanguageOption,
  RuleBudget,
  RuleMatcher,
} from '../vendor/engine/index.js'
import type { Block } from './mapfile.ts'

export type SymbolMap = Record<string, string>

/** The placeholder kinds whose values are masked on purpose and must never be
 *  newly restored into a tool's arguments, nor read back by the last scan: a
 *  regulated number, a value marked by hand, a quarantined name. One list for
 *  both (review of 55ae576). */
export const NEVER_RESTORED: readonly string[] = [
  ...Object.values(REGULATED_BASES).filter((b): b is string => typeof b === 'string'),
  MANUAL_BASE,
  '__QUARANTINED__',
]

/** What masking knows about the text in hand (spec 050): its language, the
 *  project's languages, the names the project takes from outside and the names
 *  it declares, and whether the user typed it. */
export type MaskContext = {
  language: Language | 'unknown'
  projectLanguages: ReadonlySet<Language>
  external: ReadonlySet<string>
  declared: ReadonlySet<string>
  kind: 'result' | 'prompt'
  /** The account's custom rules (spec 065), in the CLI's order. */
  rules?: readonly CustomRule[]
  /** The hook invocation's allowance of rule-matching steps, shared by every
   *  file and tool output it masks (security review). */
  budget?: RuleBudget
}

export const NO_CONTEXT: MaskContext = {
  language: 'unknown',
  projectLanguages: new Set(),
  external: new Set(),
  declared: new Set(),
  kind: 'result',
}

/** What new names are numbered from in a team checkout (spec 066): this
 *  checkout's blocks, and the tag of its local family. */
export type Numbering = {
  blocks: Record<string, Block>
  tag: string
  /** Placeholders a publish retired (aliases.json): never minted again. */
  retired?: readonly string[]
}

export function scrubSource(
  text: string,
  map: SymbolMap,
  language: LanguageOption = 'auto',
  keep: ReadonlySet<string> = new Set(),
  fileKind?: FileKind,
  team?: Numbering,
  custom: readonly CustomRule[] = [],
  budget?: RuleBudget
): { text: string; additions: SymbolMap; outside: number; rulesStopped: boolean } {
  // `keep`: names left as written - a third-party package's (spec 050 R4) -
  // through the engine's own whitelist rules, matched whole. It goes first,
  // then the account's rules (spec 065 R10).
  const rules = [
    ...keepRule(keep, 'veilio-guard-keep', 'veilio-guard: third-party names'),
    ...custom,
  ]
  // In a team, inside the member's usable block, else in the checkout's local
  // family (spec 066): the engine decides, as it does for the CLI and the MCP.
  // The file's kind, never its path (engine spec 013 R19).
  const result = anonymize(text, {
    existingMap: map,
    language,
    rules,
    ...(fileKind ? { fileKind } : {}),
    ...(team ? { team } : {}),
    ...(budget ? { ruleBudget: budget } : {}),
  })
  const additions: SymbolMap = {}
  let outside = 0
  for (const [placeholder, name] of Object.entries(result.map)) {
    if (map[placeholder] === name) continue
    additions[placeholder] = name
    // Numbered on this machine only, until the next publish renumbers it.
    if (isLocalPlaceholder(placeholder)) outside++
  }
  return { text: result.anonymized, additions, outside, rulesStopped: result.rulesStopped === true }
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
  /** The map's version when this was built. */
  version: number
  /** Its fingerprint then, kept only under strict maps. */
  fingerprint: string
}
// How many times each map object has grown in place, so caches built from it
// know when they are stale without counting its keys on every call (review of
// 6e14ec6). Grow a map only through grow().
const versions = new WeakMap<SymbolMap, number>()
export const versionOf = (map: SymbolMap) => versions.get(map) ?? 0

/** A cheap fingerprint of a map's content: its size and a sum of its
 *  entries' hashes. grow() keeps it current; a change made any other way,
 *  even one that keeps the count, no longer matches (review of 0ef312b). */
function entryHash(key: string, value: string): number {
  let h = 2166136261
  const text = `${key}\u0000${value}`
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}
function fingerprintOf(map: SymbolMap): string {
  let sum = 0
  let size = 0
  for (const [k, v] of Object.entries(map)) {
    sum = (sum + entryHash(k, v)) >>> 0
    size++
  }
  return `${size}:${sum}`
}

// Tests set this so that a map changed any other way than grow() throws at
// the next cache read, instead of masking with a stale cache (reviews of
// 5347c7c and 0ef312b). It recomputes the fingerprint, so only tests pay.
const strictMaps = () =>
  (globalThis as { __veilioStrictMaps?: boolean }).__veilioStrictMaps === true
function checkGrown(map: SymbolMap, fingerprint: string): void {
  if (strictMaps() && fingerprintOf(map) !== fingerprint)
    throw new Error('a map changed without grow(): its caches would be stale')
}

let growing = false

/** A map whose only mutator is grow(): any other write throws, so no cache
 *  built from it can go stale (review of 0ef312b). */
export function ownedMap(init: SymbolMap = {}): SymbolMap {
  const refuse = () => {
    if (!growing) throw new Error('a map is changed only through grow()')
    return true
  }
  return new Proxy(
    { ...init },
    {
      set: (target, key, value) => (refuse(), Reflect.set(target, key, value)),
      defineProperty: (target, key, d) => (refuse(), Reflect.defineProperty(target, key, d)),
      deleteProperty: (target, key) => (refuse(), Reflect.deleteProperty(target, key)),
    }
  )
}

/** Adds entries to a map object, telling the caches it changed. */
export function grow(map: SymbolMap, additions: SymbolMap): void {
  if (Object.keys(additions).length === 0) return
  growing = true
  try {
    Object.assign(map, additions)
  } finally {
    growing = false
  }
  versions.set(map, versionOf(map) + 1)
}

const compiled = new WeakMap<SymbolMap, Matcher>()

function matcher(map: SymbolMap): Matcher {
  let c = compiled.get(map)
  // Rebuilt when the same object grew (reviews of da4ff84 and 6e14ec6).
  if (c && c.version === versionOf(map)) checkGrown(map, c.fingerprint)
  if (!c || c.version !== versionOf(map)) {
    const byName = new Map<string, string>()
    const kinds = new Map<string, Set<string>>()
    for (const [placeholder, name] of Object.entries(map)) {
      if (name === '' || everydayWord(placeholder, name)) continue
      byName.set(name, placeholder)
      const kind = /^__[A-Z]+__/.exec(placeholder)?.[0] ?? placeholder
      kinds.set(name, (kinds.get(name) ?? new Set()).add(kind))
    }
    const names = [...byName.keys()].sort((a, b) => b.length - a.length)
    c = {
      re: names.length ? new RegExp(names.map(escape).join('|'), 'g') : null,
      byName,
      kinds,
      version: versionOf(map),
      fingerprint: strictMaps() ? fingerprintOf(map) : '',
    }
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
  // A whitelist rule first, as the engine checks it (spec 065).
  if (ruleMatches(name, ctx, 'whitelist')) return true
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
  const shown = withCredentialWords(text, map, readableView(map))
  return aroundTokens(dropResidue(text), (part) => inValues(part, map, shown, ctx))
}

/** Security review, round 3: an ordinary word is readable as a name, never in
 *  a value. Where output shows one - a quoted string, a `KEY=val` - the whole
 *  map is written over it; elsewhere, the readable view. */
function inValues(text: string, map: SymbolMap, shown: SymbolMap, ctx: MaskContext): string {
  if (shown === map) return replaceNames(text, map, ctx)
  let out = ''
  let at = 0
  for (const s of valueSpans(text, { kind: 'shell' })) {
    if (s.path || s.start < at) continue
    out += replaceNames(text.slice(at, s.start), shown, ctx)
    out += replaceNames(text.slice(s.start, s.end), map, ctx)
    at = s.end
  }
  return out + replaceNames(text.slice(at), shown, ctx)
}

/** An ordinary word the map holds that this text shows as a credential, or a
 *  possible one, is written over after all (code review: `client_secret:
 *  "sunshine"` with `sunshine` in an older map), as the engine does inside a
 *  credential span - and so is one that is the value of a credential-named
 *  key the scanner does not flag (`PASSWORD=sunshine`, security audit).
 *  Errs towards masking: the word is masked throughout. */
function withCredentialWords(text: string, map: SymbolMap, shown: SymbolMap): SymbolMap {
  const found = detectSecrets(text)
  const lines = text.split('\n')
  const values = new Set([
    ...found.map((f) => (lines[f.line - 1] ?? '').slice(f.column - 1, f.column - 1 + f.length)),
    ...credentialsAmong(valueSpans(text)).map((s) => s.value),
  ])
  if (values.size === 0) return shown
  let out: SymbolMap | null = null
  for (const [p, name] of Object.entries(map))
    if (!(p in shown) && values.has(name)) (out ??= { ...shown })[p] = name
  return out ?? shown
}

// Spec 064: an entry whose name is an ordinary word (a common English word,
// shared vocabulary, a toolchain's name) is never written over in what the
// model is sent - a traceback's "most recent call last", a path's `src/main`,
// Claude Code's own messages. The map keeps the entry, so text masked with it
// before still restores. Cached per map object: the map can hold thousands.
// Only the engine's own role placeholders are left out: an entry a custom
// replace rule, a manual mask or a redaction made (any other base) was masked
// on purpose and stays masked, whatever word it is (security review).
const views = new WeakMap<SymbolMap, { version: number; fingerprint: string; view: SymbolMap }>()
function readableView(map: SymbolMap): SymbolMap {
  // Keyed on the map and its version, as the matcher is: grow() is the only
  // mutator, so nothing is counted on each call (code review). The matcher is
  // then built on the view, not the map, so the strict check runs here.
  const version = versionOf(map)
  const cached = views.get(map)
  if (cached && cached.version === version) {
    checkGrown(map, cached.fingerprint)
    return cached.view
  }
  const view: SymbolMap = {}
  for (const [p, name] of Object.entries(map))
    if (!(isRolePlaceholder(p) && isOrdinaryWord(name))) view[p] = name
  views.set(map, { version, fingerprint: strictMaps() ? fingerprintOf(map) : '', view })
  return view
}

// Short words that camelCase identifiers are made of: a piece this short is
// no sign of randomness when it is one of these.
const SHORT_WORDS = new Set(
  'a an as at be by do go id if in io is it me my no of ok on or so to up us we db ui ux os'.split(
    ' '
  )
)

/** The pieces a value is cut into by case, by `_` and `-`, and by letters
 *  meeting digits, each segment between separators apart: `getXOrY` is
 *  `get X Or Y`, `S3cretpw` is `S 3 cretpw`. */
function piecesOf(value: string): { segment: string[] }[] {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((seg) => ({
      segment: seg.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+|[^A-Za-z0-9]+/g) ?? [],
    }))
}

/** Whether a value's pieces look random rather than like words: at least a
 *  third of its letter pieces are short (two letters or fewer) and not
 *  short words, a single capital between two words counting as part of the
 *  words (`getXOrYFromAToB`); or, where it has digits, a digit run sits
 *  between letters inside one segment (`S3cretpw`, `xQ7zW2`), where an
 *  identifier puts its numbers at a piece's end (`Configuration2`,
 *  `Hello_World_2026`, `Version_2_Release`). */
function randomLooking(value: string): boolean {
  let letters = 0
  let short = 0
  let interleaved = false
  for (const { segment } of piecesOf(value)) {
    segment.forEach((p, i) => {
      if (/^[0-9]+$/.test(p)) {
        if (
          i > 0 &&
          i < segment.length - 1 &&
          /[A-Za-z]/.test(segment[i - 1]!) &&
          /[A-Za-z]/.test(segment[i + 1]!)
        )
          interleaved = true
        return
      }
      if (!/^[A-Za-z]+$/.test(p)) return
      letters++
      const between =
        p.length === 1 &&
        /^[A-Z]$/.test(p) &&
        /^[A-Z]?[a-z]{2,}$/.test(segment[i - 1] ?? '') &&
        /^[A-Z][a-z]+$/.test(segment[i + 1] ?? '')
      if (p.length <= 2 && !between && !SHORT_WORDS.has(p.toLowerCase())) short++
    })
  }
  return interleaved || (letters > 0 && short / letters >= 1 / 3)
}

// Rules whose values carry their own punctuation: a dotted bearer token, a
// connection string's password. Their shape is no sign of a path.
const PUNCTUATED_RULES = new Set(['bearer-token', 'basic-auth', 'connection-string'])

/** The share of a run of letters that is vowels (`y` counts: `python`). */
function vowelRatio(letters: string): number {
  return letters.length === 0 ? 0 : (letters.match(/[aeiouy]/gi)?.length ?? 0) / letters.length
}

/** Path-, URL- or version-shaped, failing closed (reviews of d55d9e2,
 *  f9c46d4 and 92c4ca2): after an optional scheme (`https://`) or drive
 *  (`C:\`), always two or more segments between `/ \ . :` (`-` joins parts
 *  inside one); every part a number, a version's letter (`v2`), or a plain
 *  word in lower or title case, a quarter vowels or more (`y` counts) and not
 *  random-looking; and at least one word of four letters or more. Anything
 *  else is not a path and its entropy decides: a path blacked out is a
 *  nuisance, a key not carried is a leak. */
function pathShaped(value: string): boolean {
  const rest = value.replace(/^(?:[a-z][a-z0-9+.-]*:\/\/|[A-Za-z]:\\)/, '')
  // Segments are cut only at `/ . : \`: `-` alone never makes a path, or a
  // dashed key would be one (commit review of f9c46d4). Inside a segment,
  // `-` joins parts (`3-Beta`), each judged.
  const segments = rest.split(/[/.:\\]+/).filter(Boolean)
  // Two segments always, prefix or not: `https://Kq7Zw3` is no URL.
  if (segments.length < 2) return false
  let word = false
  for (const part of segments.flatMap((seg) => seg.split('-')).filter(Boolean)) {
    if (/^[0-9]+$/.test(part)) continue
    // A version's letter (`v2`, `r10`) is the one part without a vowel.
    if (/^[a-z][0-9]+$/.test(part)) continue
    // Every other part a plain word: lower or title case, a vowel in it, a
    // quarter vowels or more, not random-looking. Any mixed-case part
    // (`iDebI`, `kLemO`) and it is no path: when in doubt, carry it (commit
    // security review of 92c4ca2).
    const m = /^([A-Z]?[a-z]+)[0-9]*$/.exec(part)
    if (!m) return false
    const letters = m[1]!
    if (vowelRatio(letters) < 0.25 || randomLooking(part)) return false
    if (letters.length >= 4) word = true
  }
  return word
}

/** The words environment variable names are made of (founder decision 2,
 *  review of d55d9e2). A value counts as a variable's name only if every
 *  segment is one of these, optionally with digits after it, or a short
 *  number; an unknown word means it is not a name and it is redacted, as
 *  before decision 2. Fail closed: add a word here, never a shape rule. */
export const ENV_NAME_WORDS: ReadonlySet<string> = new Set(
  `
  ACCESS ACCOUNT ADDR ADDRESS ADMIN AGENT ALLOWED ANALYTICS ANTHROPIC API APP APPLICATION
  ARN AUDIENCE AUTH AUTHORITY AWS AZURE BACKEND BASE BEARER BUCKET BUILD CA CACHE CALLBACK
  CDN CERT CHANNEL CI CLIENT CLOUD CLOUDFLARE CLUSTER CODE CONFIG CONN CONNECTION CONSUMER
  CONTAINER CORS CREDENTIAL CREDENTIALS CRON CSRF DATA DATABASE DB DEBUG DEFAULT DEPLOY DEV
  DIR DISCORD DNS DOCKER DOMAIN DSN ELASTIC EMAIL ENABLE ENABLED ENCRYPTION ENDPOINT ENV
  ENVIRONMENT EXPIRES EXPIRY EXTERNAL FEATURE FILE FIREBASE FLAG FRONTEND FTP GATEWAY GCP
  GCS GITHUB GITLAB GOOGLE GRAPHQL GROUP GRPC HASH HEROKU HMAC HOME HOOK HOST HOSTNAME HTTP
  HTTPS ID IDENTITY INDEX INTERNAL ISSUER JWKS JWT KAFKA KEY KEYS LDAP LEVEL LICENSE LIMIT
  LOCAL LOG LOGIN LOGS MAIL MAILGUN MASTER MAX MIN MODE MODEL MONGO MONGODB MYSQL NAME
  NAMESPACE NETWORK NEXT NODE NPM OAUTH OPENAI ORG ORGANIZATION ORIGIN OUTPUT OWNER PASS
  PASSPHRASE PASSWORD PATH PAYPAL PEM PG PORT POSTGRES POSTGRESQL PREFIX PRIMARY PRIVATE
  PROD PRODUCTION PROJECT PROVIDER PROXY PUBLIC PUBLISHABLE PWD QUEUE RABBITMQ RATE READ
  REDIRECT REDIS REFRESH REGION REGISTRY RELEASE REMOTE REPO REPOSITORY REST ROLE ROOT ROUTE
  S3 SALT SANDBOX SCHEMA SCOPE SECRET SECRETS SECURE SENDGRID SENTRY SERVER SERVICE SESSION
  SFTP SHARED SIGNING SITE SLACK SMTP SNS SOCKET SQS SSH SSL SSO STAGE STAGING STORAGE STORE
  STRIPE SUPABASE TABLE TEAM TENANT TEST TIMEOUT TLS TOKEN TOPIC TRACE TWILIO UPLOAD URI URL
  USER USERNAME VAULT VERCEL VERSION WEB WEBHOOK WRITE WS WSS ZONE
  `
    .split(/\s+/)
    .filter(Boolean)
)

/** An environment variable's name used as a value (`'google-api-key':
 *  'GOOGLE_KEY'`): a reference, not a secret, left as written (founder
 *  decision 2). Only for assignment-style findings, never a bearer,
 *  basic-auth or connection-string value; upper case with at least one `_`;
 *  every segment a word of ENV_NAME_WORDS (digits after it allowed:
 *  `KEY2`) or a number; at most one number, of four digits at most
 *  (`AWS_REGION_2`, `PORT_8080`); mostly letters. Shape alone cannot tell
 *  random letter blocks from words (`XQAE_ZPOW_KIVR_TUYM`), so an unknown
 *  word means it is not a name (reviews of f19df80, 968b3b2 and d55d9e2). */
function referenceName(value: string, type: string): boolean {
  if (PUNCTUATED_RULES.has(type)) return false
  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)) return false
  const segments = value.split('_')
  const numbers = segments.filter((seg) => /^[0-9]+$/.test(seg))
  if (numbers.length > 1 || numbers.some((seg) => seg.length > 4)) return false
  const letters = value.replace(/[^A-Z]/g, '').length
  if (letters * 2 < value.replace(/_/g, '').length) return false
  return segments.every(
    (seg) => /^[0-9]+$/.test(seg) || ENV_NAME_WORDS.has(seg.replace(/[0-9]+$/, ''))
  )
}

/** A value with structural signal, the only kind the session learns and
 *  sweeps everywhere (research R4, founder decision #5). Never one holding
 *  whitespace or the punctuation of paths, URLs and versions (`/ \ . :`),
 *  whatever its entropy. `_` and `-` separate a token's parts. Otherwise it
 *  must look random, not like words or an identifier (randomLooking), and be
 *  one of:
 *  - letters and digits: eight characters or more, 3 bits or more of
 *    entropy per character (`S3cretpw`, `xQ7zW2vR9tY4pLmN`);
 *  - a mixed-class string: ten characters or more with three of lower case,
 *    upper case, digits and other symbols;
 *  - letters only: sixteen letters or more, 3 bits or more of entropy (a
 *    bearer token).
 *  `Welcome2024`, a word and a year, is an identifier by this rule and is not
 *  learned. A provider-format key is learned by its rule, whatever it looks
 *  like. A low-entropy value is not carried forward (reviews of 5347c7c and
 *  0ef312b). */
export function highSignal(value: string, type = ''): boolean {
  if (/\s/.test(value)) return false
  // A path, URL or version is never a credential to carry, whatever its
  // entropy; a bearer, basic-auth or connection-string value is, its
  // punctuation being the token's own (review of 6b5d4b0).
  if (!PUNCTUATED_RULES.has(type) && pathShaped(value)) return false
  const core = value.replace(/[_\-/.:+=\\]/g, '')
  const random = randomLooking(value)
  if (
    /[A-Za-z]/.test(core) &&
    /[0-9]/.test(core) &&
    core.length >= 8 &&
    shannonEntropy(core) >= 3
  ) {
    if (random) return true
    // A long one whose letters have few vowels is random letters, not words,
    // even with its digits at one end (`qzkvwpxmrtbn8274`; random base62 sits
    // near 0.19, `Configuration2` at 0.46; review of d55d9e2).
    if (core.length >= 12 && vowelRatio(core.replace(/[^A-Za-z]/g, '')) < 0.25) return true
  }
  if (!random) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9_-]/].filter((c) => c.test(value)).length
  if (core.length >= 10 && classes >= 3) return true
  return /^[A-Za-z]{16,}$/.test(core) && shannonEntropy(core) >= 3
}

/** Whether a value a rule of `type` destroyed is learned for the session
 *  and removed from everything masked after: a provider-format key, or a
 *  value with structural signal; never the map's own grammar. */
export function carriedForward(type: string, value: string): boolean {
  return (
    (!HEURISTIC.has(type) || highSignal(value, type)) &&
    value.length >= 6 &&
    !OWN_GRAMMAR.test(value)
  )
}

// A value made only of placeholders or redaction tokens: the map's own
// grammar is never learned as a credential (anchored: a real secret written
// against a placeholder is still learned).
const OWN_GRAMMAR = /^(?:__[A-Z][A-Z0-9_]*?__\d*)+$/

/** Where each destroyed finding stands in `text`: its start, the end of what
 *  the rule took, and the end of the key characters that run on after it (a
 *  rule may take only part of a longer key). */
function destroyedSpans(
  text: string,
  scan: ReturnType<typeof scanSecrets>
): { start: number; matched: number; end: number; type: string }[] {
  const found = scan.findings.filter((f) => f.redacted)
  if (found.length === 0) return []
  const starts = lineStarts(text)
  // In text order: the scanner reports by severity, and a span loop that
  // skips what starts before its cursor would drop an earlier finding
  // (review of da4ff84).
  return found
    .map((f) => {
      const start = (starts[f.line - 1] ?? 0) + f.column - 1
      let end = start + f.length
      while (end < text.length && KEY_CHAR.test(text[end]!)) end++
      return { start, matched: start + f.length, end, type: f.type }
    })
    .sort((a, b) => a.start - b.start)
}

export type ScanResult = ReturnType<typeof scanSecrets>

// Rules that judge by shape and context rather than a provider's format: only
// their findings defer to a value the map already masks reversibly. A
// provider-format finding (an AWS or GitHub key, a private key block, a JWT)
// always wins (security review of 933156e).
const HEURISTIC: ReadonlySet<string> = new Set([
  'password-assignment',
  'high-entropy-string',
  'connection-string',
  'basic-auth',
  'bearer-token',
  'possible-credential',
])

type Finding = ReturnType<typeof detectSecrets>[number]

/** Where each line of `text` starts, for a finding's line and column. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

/** The text of each finding the predicate keeps, one entry per occurrence. */
function findingValues(
  text: string,
  keep: (f: Finding) => boolean,
  findings: readonly Finding[] = detectSecrets(text)
): string[] {
  const found = findings.filter(keep)
  if (found.length === 0) return []
  const starts = lineStarts(text)
  return found.map((f) => {
    const start = (starts[f.line - 1] ?? 0) + f.column - 1
    return text.slice(start, start + f.length)
  })
}

/** Whether `after` holds a value, or more copies of one, than `before`. */
function adds(before: readonly string[], after: readonly string[]): boolean {
  const had = new Map<string, number>()
  for (const v of before) had.set(v, (had.get(v) ?? 0) + 1)
  for (const v of after) {
    const n = had.get(v) ?? 0
    if (n === 0) return true
    had.set(v, n - 1)
  }
  return false
}

const isProviderKey = (f: Finding) =>
  !HEURISTIC.has(f.type) && SECRET_DISPOSITIONS[f.type] === 'destroy'
const isRegulated = (f: Finding) => SECRET_DISPOSITIONS[f.type] === 'mask'

/** What a restoration writes back that the arguments as written did not
 *  hold, from one scan of each: a provider-format key (compared by value, so
 *  one already written cannot cover for another, review of 5f11069) or a
 *  regulated number the scanner reads (belt and braces beside the keys
 *  restore() resolved). */
/** What a restoration would write back that Veilio keeps from it: the kind,
 *  and for a regulated number which one. guard.ts holds the words. */
export type Withheld = { kind: 'credential' | 'manual' | 'regulated'; label?: string }

export function restoreAdds(before: string, after: string): Withheld | null {
  const b = detectSecrets(before)
  const a = detectSecrets(after)
  if (adds(findingValues(before, isProviderKey, b), findingValues(after, isProviderKey, a)))
    return { kind: 'credential' }
  if (adds(findingValues(before, isRegulated, b), findingValues(after, isRegulated, a)))
    return { kind: 'regulated' }
  return null
}

function wholeTokenIn(text: string, value: string): boolean {
  if (value === '') return false
  for (let i = text.indexOf(value); i !== -1; i = text.indexOf(value, i + 1)) {
    const before = text[i - 1]
    const after = text[i + value.length]
    // Any letter or digit, not only ASCII: `Jan` in `Janów` is inside a word.
    if (!(before && /[\p{L}\p{N}_]/u.test(before)) && !(after && /[\p{L}\p{N}_]/u.test(after)))
      return true
  }
  return false
}

// One label per regulated base, from the engine's own table: `__PAN__` is a
// payment card (review of 0ef312b).
const REGULATED_LABELS = new Map(
  Object.entries(REGULATED_BASES)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .map(([type, base]) => [base, type.replace(/-/g, ' ')])
)

/** Whether a restoration wrote back a value masked on purpose, judged by the
 *  keys restore() itself resolved (its own matching rule, review of 55ae576),
 *  each of a never-restored kind whose value `before` does not already hold.
 *  Says which kind, for the refusal's words (review of 5347c7c). */
export function restoresNeverRestored(
  before: string,
  resolved: readonly string[],
  map: SymbolMap
): Withheld | null {
  for (const p of resolved) {
    const base = NEVER_RESTORED.find((b) => p.startsWith(b))
    // Skipped only when the arguments already hold the value as a whole
    // token, not inside another word (`Jan` in `January`, review of 0ef312b).
    if (!base || !Object.hasOwn(map, p) || wholeTokenIn(before, map[p]!)) continue
    return base === MANUAL_BASE
      ? { kind: 'manual' }
      : base === '__QUARANTINED__'
        ? { kind: 'credential' }
        : { kind: 'regulated', label: REGULATED_LABELS.get(base) }
  }
  return null
}

const mapNames = new WeakMap<
  SymbolMap,
  { version: number; fingerprint: string; set: ReadonlySet<string> }
>()
/** The names a map holds, which are masked reversibly and never destroyed.
 *  Rebuilt when the same object grows (reviews of da4ff84 and 6e14ec6). */
function namesOf(map: SymbolMap): ReadonlySet<string> {
  const version = versionOf(map)
  let c = mapNames.get(map)
  if (c && c.version === version) checkGrown(map, c.fingerprint)
  if (!c || c.version !== version)
    mapNames.set(
      map,
      (c = {
        version,
        fingerprint: strictMaps() ? fingerprintOf(map) : '',
        set: new Set(Object.values(map)),
      })
    )
  return c.set
}

/** The values worth learning from a scan of `text`: what each rule took and
 *  its whole extent, when credential-like and not a name the map holds. */
function learnable(text: string, scan: ReturnType<typeof scanSecrets>, map: SymbolMap): string[] {
  const names = namesOf(map)
  const out: string[] = []
  for (const { start, matched, end, type } of destroyedSpans(text, scan)) {
    const core = text.slice(start, matched)
    if (names.has(core) && HEURISTIC.has(type)) continue
    for (const whole of end > matched ? [core, text.slice(start, end)] : [core]) {
      const v = type === 'private-key' ? pemBody(whole) : whole
      if (carriedForward(type, v)) out.push(v)
    }
  }
  return out
}

/** A private key's body: its BEGIN and END lines and its `Name: value`
 *  headers dropped, which every key of a kind shares (review round 1 item 8),
 *  and its first 64 base64 characters, where keys of one kind share the
 *  ASN.1 or OpenSSH header (review round 2). */
function pemBody(block: string): string {
  const body = block
    .replace(/-----(?:BEGIN|END) [A-Z0-9 ]+-----/g, '')
    .split('\n')
    .filter((line) => !/^[A-Za-z-]+:/.test(line.trim()))
    .join('\n')
    .trim()
  let at = 0
  for (let shared = 64; at < body.length && shared > 0; at++) if (!/\s/.test(body[at]!)) shared--
  return body.slice(at).trim()
}

/** `text` with each finding of `scan` removed as applyMap removes it: a
 *  heuristic finding that is a name `names` holds, or a variable's name, is
 *  left as written. */
function redactFindings(
  text: string,
  scan: ScanResult,
  names: ReadonlySet<string>,
  token: (core: string) => string,
  cuts?: Cut[]
): string {
  let redacted = ''
  let at = 0
  for (const { start, matched, end, type } of destroyedSpans(text, scan)) {
    if (start < at) continue
    const core = text.slice(start, matched)
    if (HEURISTIC.has(type) && (names.has(core) || referenceName(core, type))) continue
    redacted += text.slice(at, start)
    const t = token(core)
    cuts?.push([redacted.length, redacted.length + t.length, start, end])
    redacted += t
    at = end
  }
  return redacted + text.slice(at)
}

/** Where redactFindings put a token: its start and end in the redacted
 *  text, and the start and end of what it replaced in the text. */
type Cut = [number, number, number, number]

type ValueSpan = ReturnType<typeof valueSpans>[number]

/** The values of credential-named keys in `redacted` (its findings already
 *  tokens) that applyMap removes one-way: not a name `held` holds. */
function keyedSpans(redacted: string, held: ReadonlySet<string>): ValueSpan[] {
  return credentialsAmong(valueSpans(redacted)).filter((s) => !held.has(s.value))
}

// Whether a value the key rule removes is learned for the session (work
// queue e72; reviews of bbaa9d8, 0228a04 and acea47b). All of:
// - the key the engine matched names a secret: its last part is one of
//   SECRET_WORD, or two parts make a SECRET_PAIR (`secretKey`), after a
//   trailing number or version (`DB_PASSWORD_2`, `API_TOKEN_V2`); not a flag
//   (`is_secret`, `has_password`), not a token that is a cursor or a request
//   id (`NextToken`, `PaginationToken`, `csrf_token`), not a checksum, hash
//   or digest of one (`checksum/secret`), not a lookup call whose argument
//   is a name (`getSecret('stripe-key')`), and not a bare `token`, `pass`,
//   `pwd` or `secret`. A client token is a credential (Vault's
//   `client_token`); an AWS `ClientToken` idempotency key is learned too, a
//   recorded limit;
// - the value is a literal: quoted, or found by a configuration grammar in
//   text that is not code. In a file of a known language a configuration
//   line is an assignment (`self.secret_key = rotateKeyV2`);
// - not a reference (`$TOKEN`, `${DB_PASSWORD}`, `%(password)s`, `%PASSWORD%`,
//   `#{password}`, `{{ password }}`), an encrypted property (`ENC(...)`,
//   `enc(...)`, `ENC[...]`, `{cipher}...`, Mule's `![...]`), KMS or Sealed
//   Secrets ciphertext (`AQICAH...`, `AgB...` of 200 characters or more), an
//   AWS resource name (`arn:...`), an environment variable's name (founder
//   decision 2), or a lowercase kebab-case name (`db-password-v2`);
// - 16 KB at most: a longer one is removed where it stands, never thrown on;
// - the scanner's own bar (carriedForward, founder decision #5).
const SECRET_WORD = /^(?:password|passwd|pwd|pass|passphrase|secret|token|apikey)$/
const SECRET_PAIR = /^(?:api|private|access|secret|encryption|signing)_key$/
const FLAG = new Set(['is', 'has'])
const NOT_A_SECRET_TOKEN = new Set([
  'next',
  'page',
  'pagination',
  'continuation',
  'cursor',
  'starting',
  'sync',
  'resume',
  'change',
  'idempotency',
  'cancellation',
  'csrf',
  'xsrf',
  'skip',
  'delta',
  'paging',
  'resumption',
  'after',
  'scroll',
  'lock',
  'etag',
  'previous',
  'prev',
  'continue',
  'request',
])
const CONFIG: ReadonlySet<string> = new Set([
  'env',
  'ini',
  'shell',
  'yaml',
  'k8s',
  'xml',
  'pgpass',
  'inner',
  'pair',
])
// A value that names another, never learned: one that starts with `$` or
// holds `${` or `$(` anywhere (`${DB_PASSWORD:-}`, `$(vault read ...)`), or
// is wholly a template's placeholder. Conservative: a literal password that
// starts with `$` is removed where it stands and not carried forward.
const REFERENCE =
  /^\$|\$[{(]|^(?:%\([A-Za-z_]\w*\)s|%[A-Za-z_]\w*%|#\{[^{}]*\}|\{\{[^{}]*\}\})$|^ENC\(.*\)$|^ENC\[.*\]$|^\{cipher\}|^enc\(.*\)$|^!\[.*\]$|^arn:|^AQICAH|^AgB[A-Za-z0-9+/]{197,}={0,2}$/
// A resource's name (`db-password-v2`, `postgresql-password-2`): like
// decision #5's weak values, removed where it stands, never carried forward.
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)+$/
// A key with one of these parts is about a secret, not one (`checksum/secret`).
const ABOUT_A_SECRET = new Set(['checksum', 'hash', 'digest'])
// A call that looks a secret up by name: its argument is the name.
const LOOKUP = new Set(['get', 'fetch', 'read', 'load', 'lookup', 'find'])

export function namesSecret(key: string | undefined): boolean {
  if (!key) return false
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (parts.some((p) => ABOUT_A_SECRET.has(p)) || LOOKUP.has(parts[0] ?? '')) return false
  if (parts.length > 1 && /^v?\d+$/.test(parts[parts.length - 1]!)) parts.pop()
  const last = parts[parts.length - 1]?.replace(/(?<=[a-z])v?\d+$/, '')
  const prev = parts[parts.length - 2]
  if (!last || (prev !== undefined && FLAG.has(prev))) return false
  if (last === 'token' && prev !== undefined && NOT_A_SECRET_TOKEN.has(prev)) return false
  // A bare `token`, `pass`, `pwd` or `secret` names no secret: `PWD` is the
  // working directory, a k8s `secret:` names a resource.
  if (SECRET_WORD.test(last)) return parts.length > 1 || !/^(?:token|pass|pwd|secret)$/.test(last)
  return prev !== undefined && SECRET_PAIR.test(`${prev}_${last}`)
}

// Only a token redactFindings wrote, not any value shaped like a placeholder.
const REDACTION_ONLY = /^(?:__REDACTED_[A-Z0-9_]+__)+$/

/** What stands in a key's value: a slot that is a finding's token keeps it,
 *  so one secret reads as one token. (When a credential is learned beside the
 *  token, it is the slot, and the whole takes its own token.) */
function slotToken(slot: string, known: Destroyed): string {
  return REDACTION_ONLY.test(slot) ? slot : known.tokenFor(slot)
}

/** What a key-rule span is learned as, and the slot its token stands in: its
 *  value, and for an unquoted one also its `&`, `,` or `;` parts that have no
 *  key of their own or a key that names a secret (`Host=`, `commit=` and the
 *  like are not credentials). A part holding a finding's token is never
 *  learned. The slot is the first part when learned, else the first learned
 *  value. `code`: the text is a file of a known language. */
function keyedParts(span: ValueSpan, code: boolean): { slot: string; learned: string[] } {
  const v = span.value
  const cut = span.quoted ? -1 : v.search(/[&,;]/)
  const core = cut > 0 ? v.slice(0, cut) : v
  if (
    !namesSecret(span.key) ||
    !(span.quoted || (!code && CONFIG.has(span.grammar ?? ''))) ||
    v.length > MAX_VALUE ||
    REFERENCE.test(v.trim()) ||
    KEBAB.test(v) ||
    referenceName(v, 'password-assignment') ||
    referenceName(v.replace(/_V(\d+)$/, '_$1'), 'password-assignment')
  )
    return { slot: core, learned: [] }
  const parts =
    cut > 0
      ? v.split(/[&,;]/).flatMap((x) => {
          const pair = /^([A-Za-z_][\w.-]*)=(.*)$/s.exec(x)
          // A part with a key of its own is learned only when that key names a secret.
          return pair ? (namesSecret(pair[1]) ? [pair[2]!] : []) : [x]
        })
      : []
  const learned = [...new Set([core, v, ...parts])].filter(
    (x) => !x.includes('__REDACTED_') && carriedForward('password-assignment', x)
  )
  return { slot: learned.includes(core) ? core : (learned[0] ?? core), learned }
}

/** A text's key-rule removal, worked out once: the text with its findings
 *  removed under their tokens, and the values of credential-named keys in it
 *  that are not names the map holds. applyMap takes it from the learning
 *  pass while the text and the map are as they were. */
export type Keyed = { redacted: string; spans: ValueSpan[] }

function keyedOf(text: string, scan: ScanResult, map: SymbolMap, known: Destroyed): Keyed {
  const redacted = redactFindings(text, scan, namesOf(readableView(map)), (core) =>
    known.tokenFor(core)
  )
  return { redacted, spans: keyedSpans(redacted, namesOf(map)) }
}

/** `text` with each cut [from, to) replaced by its token (security review
 *  of 72e1e4c): cuts that overlap are merged under the first one's token,
 *  and a cut over line breaks is replaced on each of its lines, the breaks
 *  and each line's indentation kept, so the text keeps its line count. */
export function replaceCuts(text: string, cuts: [number, number, string][]): string {
  const merged: [number, number, string][] = []
  for (const c of [...cuts].sort((x, y) => x[0] - y[0] || y[1] - x[1])) {
    const last = merged[merged.length - 1]
    if (last && c[0] < last[1]) last[1] = Math.max(last[1], c[1])
    else merged.push([...c])
  }
  let out = ''
  let at = 0
  for (const [from, to, token] of merged) {
    const piece = text
      .slice(from, to)
      .split('\n')
      .map((p, i) => (i > 0 ? p.replace(/^(\s*)\S[\s\S]*$/, `$1${token}`) : p === '' ? p : token))
      .join('\n')
    out += text.slice(at, from) + piece
    at = to
  }
  return out + text.slice(at)
}

/** Spec 074 pass 2: the key rule over one file's run of search lines, read
 *  as that file's own text (`code`: a file of a known language), so a key on
 *  one line and its value on the next are one span. Each key-rule value is
 *  replaced where it stands, under its own token as a search line's is,
 *  except one the per-line masking reads itself: on one line, and found by
 *  the key rule on that line as printed (`prefixes`: each line's search
 *  prefix) at the same place with the same value - replaced here, the line
 *  would be read again differently. Where the line as printed reads an
 *  overlapping value another way, the two together are replaced, so neither
 *  reading shows a part the other hides. `everywhere` (the key is the
 *  file's name) replaces every value. The scanner's findings are left to the
 *  per-line masking.
 *  `learned`: the values CE #204's rules carry forward (keyedParts), from
 *  every span. */
export function keyedRun(
  text: string,
  map: SymbolMap,
  known: Destroyed,
  code: boolean,
  fileKind?: FileKind,
  everywhere = false,
  prefixes: readonly string[] = []
): { text: string; learned: string[] } {
  const scan = scanSecrets(text, 'redact', fileKind ? { fileKind } : {})
  const cuts: Cut[] = []
  const redacted = redactFindings(
    text,
    scan,
    namesOf(readableView(map)),
    (core) => known.tokenFor(core),
    cuts
  )
  // A position in the redacted text, in the text: one inside a token is the
  // start (or the end) of what the token replaced.
  const original = (pos: number, end: boolean) => {
    let delta = 0
    for (const [rs, re, os, oe] of cuts) {
      if (end ? pos <= rs : pos < rs) break
      if (end ? pos <= re : pos < re) return end ? oe : os
      delta = oe - re
    }
    return pos + delta
  }
  const starts = lineStarts(text)
  /** What to replace for [from, to): null when the per-line masking finds
   *  that very span itself (security review of bafafe8: by place and value,
   *  never by the key's text on the line); else it, widened over every span
   *  the line as printed reads overlapping it. */
  const extent = (from: number, to: number): [number, number] | null => {
    const value = text.slice(from, to)
    if (value.includes('\n')) return [from, to] // replaced on each line (replaceCuts)
    let n = starts.length - 1
    while (starts[n]! > from) n--
    const start = starts[n]!
    const end = text.indexOf('\n', start)
    const prefix = prefixes[n] ?? ''
    const body = text.slice(start, end === -1 ? undefined : end)
    let [a, b] = [from, to]
    for (const s of credentialsAmong(valueSpans(prefix + body))) {
      const [sa, sb] = [start + Math.max(0, s.start - prefix.length), start + s.end - prefix.length]
      if (sa === from && s.value === value) return null
      if (sa < to && sb > from) [a, b] = [Math.min(a, sa), Math.max(b, sb)]
    }
    return [a, b]
  }
  const learned: string[] = []
  // Every cut first, then merged (security review of 72e1e4c: one that only
  // partly overlaps the cut before it was dropped).
  const replace: [number, number, string][] = []
  for (const span of keyedSpans(redacted, namesOf(map))) {
    learned.push(...keyedParts(span, code).learned)
    const from = original(span.start, false)
    const to = original(span.end, true)
    const cut = everywhere ? ([from, to] as [number, number]) : extent(from, to)
    if (cut) replace.push([cut[0], cut[1], known.tokenFor(span.value)])
  }
  return { text: replaceCuts(text, replace), learned }
}

/** Each text's scan and key-rule removal, from the pass that learns from it,
 *  for its masking to reuse. */
export type Prepared = Map<
  string,
  { scan: ScanResult; keyed: Keyed; code: boolean; fileKind: FileKind | undefined }
>

/** Every value the scans of a whole result destroy, so that a secret found in
 *  one string of it (a Grep line, a field) is removed from all of them
 *  (security review of 75fe4c0). `known` numbers the tokens, `prepared`
 *  keeps each text's work for its masking, `code`: the texts are a file of a
 *  known language. */
export function destroyedValues(
  texts: readonly string[],
  map: SymbolMap = {},
  scan?: ScanResult,
  fileKind?: FileKind,
  options: { code?: boolean; known?: Destroyed; prepared?: Prepared; keyed?: boolean } = {}
): string[] {
  const values = new Set<string>()
  const scanOptions = fileKind ? { fileKind } : {}
  const known = options.known ?? new Destroyed()
  const code = options.code ?? false
  for (const text of texts) {
    const found = scan ?? scanSecrets(text, 'redact', scanOptions)
    for (const value of learnable(text, found, map)) values.add(value)
    if (options.keyed === false) continue
    const keyed = keyedOf(text, found, map, known)
    options.prepared?.set(text, { scan: found, keyed, code, fileKind })
    for (const span of keyed.spans)
      for (const value of keyedParts(span, code).learned) values.add(value)
  }
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

// Spec 078 R3: a removed credential's slices. 16 characters of a value with
// letters and digits only is high-entropy enough that a chance match in
// other text is negligible; a name is held to 12.
const WINDOW = 16
const NAME_WINDOW = 12
/** Letters and digits only, lower case: the form two copies of a value share
 *  whatever separators or case they were printed with. An escape sequence
 *  written as text (`\\n`, `\\x0a`, `\\u000a`) is a separator too (review
 *  round 1 item 7): its letters would split a window. */
const compact = (text: string) =>
  text
    .replace(/\\(?:[ntr0]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})/g, '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toLowerCase()

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
  /** Spec 078 R3: every 16- and 12-character window of each learned value of
   *  16 or more letters and digits, compacted, forwards and reversed. */
  private windows16 = new Set<string>()
  private windows12 = new Set<string>()
  /** Grows whenever a value with windows is learned. */
  version = 0
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
      const c = compact(v)
      if (c.length >= WINDOW) {
        for (const form of [c, [...c].reverse().join('')]) {
          for (let i = 0; i + WINDOW <= form.length; i++)
            this.windows16.add(form.slice(i, i + WINDOW))
          for (let i = 0; i + NAME_WINDOW <= form.length; i++)
            this.windows12.add(form.slice(i, i + NAME_WINDOW))
        }
        this.version++
      }
    }
    if (tooLong) throw new Error('a destroyed credential too long to remove safely')
  }
  /** Whether `text` holds 16 characters of a learned value in another form:
   *  separators or case changed, sliced, reversed, or base64/hex encoded
   *  (spec 078 FR-005). Linear in the text. */
  reshaped(text: string, runs?: () => readonly string[]): boolean {
    if (this.windows16.size === 0) return false
    // Compaction joins a column and drops separators; reversed windows are
    // in the set: only the encoded runs need decoding (`runs`: done already).
    for (const form of [text, ...(runs ? runs() : decodedRuns(text))]) {
      const c = compact(form)
      for (let i = 0; i + WINDOW <= c.length; i++)
        if (this.windows16.has(c.slice(i, i + WINDOW))) return true
    }
    return false
  }
  /** Whether a name shares 12 characters with a learned value (FR-006). */
  sharesWindow(name: string): boolean {
    if (this.windows12.size === 0) return false
    const c = compact(name)
    for (let i = 0; i + NAME_WINDOW <= c.length; i++)
      if (this.windows12.has(c.slice(i, i + NAME_WINDOW))) return true
    return false
  }
  /** A name that holds one of these credentials, with the placeholder it is
   *  masked by this session: replaced whole before the credential inside it is
   *  swept, so the identifier reads as one name (review of 7b930ad). */
  hold(name: string, placeholder: string): void {
    if (this.tokens.get(name) === placeholder) return
    this.tokens.set(name, placeholder)
    this.sweep.set(name, periodOf(name))
    this.list = null
  }
  /** The values swept from later texts, with each one's period. */
  get values(): string[] {
    // Longest first, so a held name wins over the credential inside it.
    return (this.list ??= [...this.sweep.keys()].sort((a, b) => b.length - a.length))
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
  options: {
    scanned?: boolean
    known?: Destroyed
    scan?: ScanResult
    swept?: boolean
    /** The file's kind (engine spec 013 R19): its credentials are redacted
     *  here, in place, and only learned when strong (decision 5). */
    fileKind?: FileKind
    /** The text is a file of a known language: a key's unquoted value on a
     *  configuration-shaped line is code, not learned. */
    code?: boolean
    /** The learning pass's work on this very text and map (destroyedValues). */
    keyed?: Keyed
    /** false: a key's value is removed under its own token, never learned
     *  (a Grep line). */
    learn?: boolean
  } = {}
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
  const scan =
    options.scan ??
    scanSecrets(text, 'redact', options.fileKind ? { fileKind: options.fileKind } : {})
  // The exemption below ("a value the map holds is masked reversibly") is true
  // only of names the masking will actually write over: an ordinary word is
  // left as written now, so a credential that is one is redacted (code review).
  const shown = readableView(map)
  known.learn(learnable(text, scan, shown))
  const keyed = options.keyed ?? keyedOf(text, scan, map, known)
  let redacted = keyed.redacted
  // The value of a credential-named key - one CONTAINS a credential word -
  // whole, up to its delimiter, whatever the map holds (security review: with
  // an empty map nothing was written over `DB_PASSWORD=sunshine`). A map name
  // keeps its placeholder (withCredentialWords); any other value is removed
  // one-way. Only `$NAME` and `${NAME}` are references: `DB_PASSWORD=
  // ADMIN_PASSWORD` is a value (round 3). A strong one under a key that
  // names a secret is learned for the session (keyedParts); a weak one
  // elsewhere is an ordinary word.
  let unvalued = ''
  let at = 0
  for (const span of keyed.spans) {
    const { slot, learned } = keyedParts(span, options.code ?? false)
    if (options.learn !== false) known.learn(learned)
    // The whole value goes, as before; a slot that is already a finding's
    // token keeps that token, so one secret reads as one token.
    // A text the key rule learns nothing from (a Grep line) is masked as
    // before e72: the whole value under its own token.
    const token = options.learn === false ? known.tokenFor(span.value) : slotToken(slot, known)
    unvalued += redacted.slice(at, span.start) + token
    at = span.end
  }
  redacted = unvalued + redacted.slice(at)
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

// Custom-rule patterns run on the engine's linear-time matcher, compiled once
// per pattern (a teammate's pattern cannot freeze the guard; spec 065), and
// draw on the invocation's budget. Once it is spent no rule keeps a name
// readable and every name a replace rule might match is masked: the engine's
// direction (security review).
const ruleMatchers = new Map<string, RuleMatcher | null>()
function ruleMatches(name: string, ctx: MaskContext, type: CustomRule['type']): boolean {
  if (!ctx.rules?.length) return false
  const stopped = () => ctx.budget?.spent === true && ctx.rules!.some((r) => r.type === type)
  if (stopped()) return type === 'replace'
  const hit = ctx.rules.some((r) => {
    if (r.type !== type) return false
    let m = ruleMatchers.get(r.pattern)
    if (m === undefined) {
      if (ruleMatchers.size > 1000) ruleMatchers.clear()
      ruleMatchers.set(r.pattern, (m = compileRulePattern(r.pattern)))
    }
    return m?.test(name, ctx.budget) ?? false
  })
  return stopped() ? type === 'replace' : hit
}

const WORD_TOKEN = /(?<![\w$])[A-Za-z_$][\w$]*(?![\w$])/g

/** Masks the names shaped like identifiers that are still in `text` after the
 *  map was applied, minting their placeholders through the engine so the
 *  numbering is the map's, and returns them for the map file. Not for what the
 *  user typed: a name they type that the map does not have goes as typed
 *  (spec 033 COVERAGE). */
export function maskShaped(
  text: string,
  map: SymbolMap,
  ctx: MaskContext,
  team?: Numbering
): { text: string; additions: SymbolMap } {
  // What the user typed is not shape-masked; a replace rule's names are
  // (spec 065), as everywhere else.
  if (ctx.kind === 'prompt' && !ctx.rules?.some((r) => r.type === 'replace'))
    return { text, additions: {} }
  // A name written against a redaction token is masked like any other.
  if (text.includes('__REDACTED_')) {
    let working = map
    const additions: SymbolMap = {}
    const out = aroundTokens(text, (part) => {
      const r = maskShapedPart(part, working, ctx, team)
      if (Object.keys(r.additions).length) {
        Object.assign(additions, r.additions)
        working = { ...working, ...r.additions }
      }
      return r.text
    })
    return { text: out, additions }
  }
  return maskShapedPart(text, map, ctx, team)
}

function maskShapedPart(
  text: string,
  map: SymbolMap,
  ctx: MaskContext,
  team?: Numbering
): { text: string; additions: SymbolMap } {
  const placeholderOf = new Map(Object.entries(map).map(([p, name]) => [name, p]))
  const reused: SymbolMap = {}
  const found = new Set<string>()
  // Spec 065: a name a replace rule matches that is still here - not in the
  // map, or held only under an engine placeholder 064 shows - is minted with
  // the rule's placeholder. A whitelisted or third-party name is left.
  if (ctx.rules?.some((r) => r.type === 'replace')) {
    const shown = namesOf(readableView(map))
    for (const [token] of text.matchAll(WORD_TOKEN))
      if (
        !shown.has(token) &&
        !isPlaceholder(token) &&
        !ctx.external.has(token) &&
        !keywordIn(token, ctx) &&
        !ruleMatches(token, ctx, 'whitelist') &&
        ruleMatches(token, ctx, 'replace')
      )
        found.add(token)
  }
  for (const [token] of ctx.kind === 'prompt' ? [] : text.matchAll(SHAPED)) {
    if (found.has(token)) continue
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
  // Numbered as a source read is (spec 063, 066): a name met first in a test's
  // output once took the next number above the map - a teammate's (team
  // bench, 2026-10-30).
  const minted = anonymize(source, {
    existingMap: map,
    language: 'typescript',
    secrets: 'off',
    ...(ctx.rules?.length ? { rules: [...ctx.rules] } : {}),
    ...(team ? { team } : {}),
    ...(ctx.budget ? { ruleBudget: ctx.budget } : {}),
  }).map
  const additions: SymbolMap = {}
  for (const [placeholder, name] of Object.entries(minted))
    if (found.has(name) && map[placeholder] !== name) additions[placeholder] = name
  return { text: replaceNames(text, { ...reused, ...additions }, ctx), additions }
}

// Placeholders that stand for a value masked on purpose: a regulated number
// (`__PAN__1`) or a value the author marked by hand (`__MANUAL__1`). They stay
// masked when the last scan reads the rest back.
// A quarantined name holds a destroyed credential: never read back either.
const KEPT_MASKED = NEVER_RESTORED

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
  // credential left behind (review of 99325ba) - unless it is an ordinary word,
  // which is not written over (spec 064, code review).
  const names = namesOf(readableView(map))
  const starts = lineStarts(real)
  return found
    .filter((f) => {
      const start = (starts[f.line - 1] ?? 0) + f.column - 1
      const v = real.slice(start, start + f.length)
      return !HEURISTIC.has(f.type) || !(names.has(v) || referenceName(v, f.type))
    })
    .map((f) => f.type)
}

export function restoreArgs(
  text: string,
  map: SymbolMap
): { text: string; unresolved: string[]; altered: string[]; resolved: string[] } {
  const r = restore(text, map, { strip: 'none' })
  return {
    text: r.restored,
    unresolved: r.report.unresolved,
    altered: r.report.altered,
    resolved: r.report.resolved,
  }
}

// ── spec 078: encoded copies (research R2 option A, R3) ──────────────────────

const BASE64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g
// Hex digit pairs, optionally spaced or on several lines (xxd -p, od -tx1).
const HEX_RUN = /[0-9a-fA-F]{2}(?:[ \t\r\n]*[0-9a-fA-F]{2}){7,}/g

const UTF8 = new TextDecoder('utf-8', { fatal: false })
/** Decoded bytes as text, never judged as a whole: a name padded with binary
 *  bytes still reads as a word between replacement characters (security
 *  review of the encoded-name check). */
function asText(bytes: string): string {
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i)
  return UTF8.decode(out)
}

function decodeBase64(run: string): string | null {
  const plain = run.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (plain.length % 4 === 1) return null
  try {
    return asText(atob(plain + '='.repeat((4 - (plain.length % 4)) % 4)))
  } catch {
    return null
  }
}

function decodeHex(run: string): string | null {
  const digits = run.replace(/\s+/g, '')
  let out = ''
  for (let i = 0; i + 1 < digits.length; i += 2)
    out += String.fromCharCode(parseInt(digits.slice(i, i + 2), 16))
  return asText(out)
}

/** The forms a text can carry a copy of a name in that masking does not
 *  read: base64, base64url and hex runs decoded (lines of a wrapped run
 *  joined first), each line reversed, and a column of 4 or more lines of 1-3
 *  characters joined. Linear in the text. */
export function encodedForms(text: string, runs?: readonly string[]): string[] {
  const lines = text.split('\n')
  const out = runs ? [...runs] : decodedRuns(text, lines)
  out.push(lines.map((l) => [...l].reverse().join('')).join('\n'))
  let column: string[] = []
  for (const line of [...lines, '']) {
    const l = line.replace(/\r$/, '')
    if (l.length >= 1 && l.length <= 3) column.push(l)
    else {
      if (column.length >= 4) out.push(column.join(''))
      column = []
    }
  }
  return out
}

/** The base64, base64url and hex runs of a text, decoded. */
export function decodedRuns(text: string, lines = text.split('\n')): string[] {
  // The whole text, however long: every step below is linear, and a shell's
  // output reaches the guard already capped by Claude Code.
  const out: string[] = []
  // A wrapped base64 run (base64's 76 columns) is one run: whole lines of
  // base64 characters joined, line by line (a regex across lines
  // backtracks quadratically on a long run).
  const joined: string[] = []
  for (const line of lines) {
    const l = line.replace(/\r$/, '')
    const whole = /^[A-Za-z0-9+/_-]+={0,2}$/.test(l)
    const last = joined.length - 1
    if (whole && last >= 0 && joined[last]!.length >= 16 && !/=$/.test(joined[last]!))
      joined[last] += l
    else joined.push(whole ? l : '')
  }
  for (const source of [text, ...joined.filter((j) => j.length > 76)])
    for (const m of source.matchAll(BASE64_RUN)) {
      const d = decodeBase64(m[0])
      if (d !== null) out.push(d)
    }
  for (const m of text.matchAll(HEX_RUN)) {
    const d = decodeHex(m[0])
    if (d !== null) out.push(d)
  }
  return out
}

const nameSets = new WeakMap<SymbolMap, ReadonlySet<string>>()
/** A masked name of 4 or more characters that one of `text`'s encoded forms
 *  holds, or null. Readable ordinary words (spec 064) are not masked, so
 *  they are not looked for; no case-folding (FR-018a). */
export function encodedName(
  text: string,
  map: SymbolMap,
  runs?: () => readonly string[]
): string | null {
  const view = readableView(map)
  let names = nameSets.get(view)
  if (!names) {
    names = new Set([...namesOf(view)].filter((n) => n.length >= 4))
    nameSets.set(view, names)
  }
  if (names.size === 0) return null
  // shortcut: names are matched as whole words of the decoded text, so one
  // glued to other word characters is missed; upgrade to a substring
  // automaton if that is shown to matter.
  for (const form of encodedForms(text, runs?.()))
    for (const word of form.split(/[^A-Za-z0-9_$.\-/]+/)) {
      if (names.has(word)) return word
      for (const piece of word.split(/[.\-/]+/)) if (names.has(piece)) return piece
    }
  return null
}
