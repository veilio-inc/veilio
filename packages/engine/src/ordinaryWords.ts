// Spec 064: names the engine leaves as written because they are not anybody's
// secret - a single common English word, the vocabulary every codebase shares
// (src, util, com), and the toolchains a model is told to run. In spec 062's
// sessions 57% of placeholders hid such a word, 56% sat in file paths, and the
// model listed the whole tree to find files it could no longer read.
//
// A name with an inner capital, an underscore or a digit is never ordinary: it
// is a choice somebody made (ledgerEntry, berth_quorum, invoice2). Neither is a
// mixed-case word no dictionary spells (lEdger). Custom rules still win.

import { isKeyword, LANGUAGES, type Language } from './languages.js'
import { ENGLISH_WORDS } from './words.js'

/** Words every codebase shares and toolchain names, beyond the dictionary. */
const PROGRAMMING = [
  // Path and package segments
  'src',
  'lib',
  'libs',
  'util',
  'utils',
  'pkg',
  'cmd',
  'bin',
  'dist',
  'tmp',
  'docs',
  'spec',
  'specs',
  'tests',
  'test',
  'main',
  'com',
  'org',
  'net',
  'io',
  'api',
  'apis',
  'app',
  'apps',
  'impl',
  'internal',
  'config',
  'configs',
  'conf',
  'env',
  'envs',
  'dev',
  'prod',
  'vendor',
  'assets',
  'static',
  'public',
  'dto',
  'dao',
  'repo',
  'repos',
  'middleware',
  'handler',
  'handlers',
  'helpers',
  'models',
  'services',
  // Languages and formats
  'java',
  'kotlin',
  'scala',
  'javascript',
  'typescript',
  'python',
  'ruby',
  'php',
  'csharp',
  'rust',
  'golang',
  'sql',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'css',
  'csv',
  'toml',
  'markdown',
  'utf',
  'ascii',
  'http',
  'https',
  'url',
  'urls',
  'uri',
  'uuid',
  'regex',
  'stdin',
  'stdout',
  'stderr',
  'stdlib',
  // Toolchains, test frameworks and package managers
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'deno',
  'bun',
  'tsc',
  'tsx',
  'vite',
  'vitest',
  'jest',
  'mocha',
  'chai',
  'eslint',
  'prettier',
  'webpack',
  'babel',
  'pytest',
  'unittest',
  'tox',
  'pip',
  'pipenv',
  'poetry',
  'ruff',
  'mypy',
  'black',
  'junit',
  'testng',
  'mockito',
  'hamcrest',
  'mvn',
  'maven',
  'gradle',
  'surefire',
  'minitest',
  'rspec',
  'rake',
  'rails',
  'bundler',
  'gem',
  'gems',
  'cargo',
  'rustc',
  'dotnet',
  'nuget',
  'xunit',
  'nunit',
  'docker',
  'git',
  // Everyday code words no dictionary lists
  'args',
  'kwargs',
  'params',
  'param',
  'attr',
  'attrs',
  'init',
  'ctx',
  'req',
  'res',
  'cfg',
  'impl',
  'enum',
  'enums',
  'int',
  'bool',
  'str',
  'dict',
  'async',
  'await',
  'todo',
  'fixme',
  'func',
  'ptr',
]

let words: Set<string> | null = null
function dictionary(): Set<string> {
  if (!words) words = new Set([...ENGLISH_WORDS.split(' '), ...PROGRAMMING])
  return words
}

/** A single dictionary word, written lower-case, Capitalised or in capitals. */
export function isOrdinaryWord(name: string): boolean {
  if (!/^(?:[a-z]+|[A-Z][a-z]+|[A-Z]+)$/.test(name)) return false
  return dictionary().has(name.toLowerCase())
}

// Security review, round 3 (an amendment to spec 064): an ordinary word is
// readable only as an identifier or a path segment. In a value position - a
// string literal; in configuration the text after `=` or `:`, or on the line
// below an empty one; XML element text; a command's `KEY=val` prefix - it is
// masked, whatever its key is called. A list of dangerous credential syntaxes
// could never be complete, so the value positions are listed instead.
// The unit is the whole value up to its delimiter: `"Summer2024!"` is one.

/** A key that names a credential (security review, round 4): one of these
 *  anywhere in it, or a camel, snake or kebab segment that starts or ends with
 *  a short one - `dbPw`, `userPW`, `DBPW`, `--db-password`, `DB_PIN`. */
const CREDENTIAL_WORD = /pass|pwd|secret|token|key|auth|cred|private|salt|jwt|bearer|mnemonic/i
const CREDENTIAL_SEGMENT = /^(?:pw|otp|pin|seed|cert)|(?:pw|otp|pin|seed|cert)$/
const CREDENTIAL = {
  test(name: string): boolean {
    if (CREDENTIAL_WORD.test(name)) return true
    for (const segment of name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/))
      if (CREDENTIAL_SEGMENT.test(segment.toLowerCase())) return true
    return false
  },
}
// Shapes no credential has, as the secret scanner reads them (engine
// 1.12.2): text already masked, a flag's word, a number, a placeholder, a
// command, a CI expression, a YAML alias, a URL without userinfo, a path
// that reads as one (two segments, an extension, or `~/`, `./`, `$HOME/`).
// Such a value is still a value: masked reversibly, never shown.
const NOT_SECRET =
  /^(?:.{1,2}|(?:__[A-Z][A-Z0-9_]*__\d*)+|true|false|null|none|nil|undefined|yes|no|on|off|~|\d+|<[^<>]*>|\$\(.*|`.*|\$\{\{.*\}\}|\*[\w-]+|[a-z][\w+.-]*:\/\/[^\s@]*|(?:~|\.{1,2}|\$\{?\w+\}?)?(?:\/[\w.@~+-]+){2,}\/?|(?:~|\.{1,2}|\$\{?\w+\}?)?\/[\w@~+-]+\.\w{1,8}|(?:~|\.{1,2}|\$\{?\w+\}?)\/[\w.@~+-]+)$/i
// An unquoted `$NAME` or `${NAME}` is a reference to another variable; a
// quoted one (`"$unshine"`) is a value.
const REFERENCE = /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/
// A path keeps 064's readable segments: no space, no scheme, a separator.
const PATH = /^[\w.@~+-]*[\\/][\w.@~+\\/-]*$/

/** Where configuration keeps its values, by grammar (`fileKindOf`). */
export type ValueGrammar = 'dotenv' | 'yaml' | 'shell' | 'ini' | 'xml' | 'pgpass'

export interface ValueSpan {
  start: number
  end: number
  value: string
  /** Its key names a credential: under `redact` it is removed one-way. */
  credential: boolean
  /** A path: its ordinary segments stay readable. Never a credential. */
  path: boolean
  /** A bare name after a credential key in code (`password = sunshine`):
   *  perhaps a variable, so masked reversibly, never removed. */
  bare?: boolean
}

export interface ValueScan {
  /** String literals, as the tokenizer found them: contents only. Absent:
   *  quoted runs on one line are taken as strings. */
  strings?: readonly { start: number; end: number; module?: boolean }[]
  /** `code`: only strings are values. A grammar adds its own positions.
   *  Absent: text of no known kind - pasted text, a `.md`, command output -
   *  where every grammar applies, a bare name after a credential key too. */
  kind?: ValueGrammar | 'code'
  language?: Language
  /** The text came from a code file (by its path or its language), whatever
   *  grammar it is read by: an unquoted call or member access there reads a
   *  value (`os.getenv(...)`, `config.secret`). Never in configuration. */
  code?: boolean
}

const QUOTED = /(?<![A-Za-z0-9])(["'`])([^\n]{0,4096}?)\1/g
const KEY_TOKEN = /[A-Za-z_$][\w$]*/g
const KEY_STRING = /["'`]([\w.$-]{1,100})["'`]/g

// A language's own word names nothing (`private`, `const`, `str`) - but
// `key`, a TypeScript keyword, is a key's name all the same.
function keyword(word: string, language: Language | undefined): boolean {
  if (/^keys?$/i.test(word)) return false
  return language ? isKeyword(word, language) : LANGUAGES.some((l) => isKeyword(word, l))
}

/** Whether the value at `at` sits under a credential key: any name, or any
 *  key-shaped string, between it and the start of its statement or pair, at
 *  most 256 characters back on its line (`password: Optional[str] = `,
 *  `define('DB_PASSWORD', `, `secrets = Map.of("k", `). A comma ends the
 *  search only where a new pair starts after it (`"pass": "x", "color": `). */
function credentialBefore(text: string, at: number, language: Language | undefined): boolean {
  // A C# property's accessors stand between its name and its value.
  let prefix = lineBefore(text, at).replace(ACCESSORS, ' ')
  const statement = Math.max(
    prefix.lastIndexOf(';'),
    prefix.lastIndexOf('{'),
    prefix.lastIndexOf('}')
  )
  prefix = prefix.slice(statement + 1)
  // From the right; lastIndexOf(',', -1) would find index 0 again.
  for (let c = prefix.lastIndexOf(','); c !== -1; c = c > 0 ? prefix.lastIndexOf(',', c - 1) : -1)
    if (/[:=]/.test(prefix.slice(c + 1))) {
      prefix = prefix.slice(c + 1)
      break
    }
  // A call's first argument is keyed by the call: `setPassword("...")` is,
  // `os.getenv("SECRET_KEY")` looks a name up.
  const call = /([A-Za-z_$][\w$]*)[ \t]*\([ \t]*$/.exec(prefix)
  if (call) return CREDENTIAL.test(call[1]!) && !keyword(call[1]!, language)
  // In a tag, `key="..."` names the entry (`<add key="Theme" value="dark"/>`).
  if (/<[\w.:-]+(?:\s[^<>]*)?\s(?:key|name|id)[ \t]*=[ \t]*$/i.test(prefix)) return false
  for (const m of prefix.matchAll(KEY_STRING)) if (CREDENTIAL.test(m[1]!)) return true
  for (const [t] of prefix.replace(STRING, ' ').matchAll(KEY_TOKEN))
    if (CREDENTIAL.test(t) && !keyword(t, language)) return true
  return false
}
const STRING = /(["'`])[^"'`]*\1/g
const ACCESSORS = /\{\s*(?:get|set|init)\b[^{}]*\}/g

/** The text before `at` on its line, at most 256 characters: bounded, so
 *  many values on one long line stay linear. */
function lineBefore(text: string, at: number): string {
  const window = text.slice(Math.max(0, at - 256), at)
  return window.slice(window.lastIndexOf('\n') + 1)
}

/** Inside a `$( ... )` its line opened and has not closed. */
function inCommand(text: string, at: number): boolean {
  const before = lineBefore(text, at)
  return (before.match(/\$\(/g)?.length ?? 0) > (before.match(/\)/g)?.length ?? 0)
}

// In code, an unquoted call or member access (`getToken()`, `settings.token`)
// reads a value; it is not one. The whole value, and only in code: in
// configuration `Xk9m.Q2v` is a password (security review, round 4).
const CALL_OR_MEMBER = /^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)+(?:\([^()]*\))?|\([^()]*\));?$/

/** A value that may be a secret: one no shape above rules out. */
function secretShaped(value: string, quoted: boolean, code = false): boolean {
  const v = value.trim()
  return (
    v !== '' &&
    !NOT_SECRET.test(v) &&
    (quoted || (!REFERENCE.test(v) && !(code && CALL_OR_MEMBER.test(v))))
  )
}

// The credential net (security review, round 4): in every file that is not
// code, a name holding a credential word, any separator, and the value up to
// its delimiter. Fail closed: only a shape no credential has (NOT_SECRET: a
// placeholder, one or two characters, a number, a path, a URL without
// userinfo, a CI expression), a `$NAME` reference or a language keyword
// (`null`, `None`) is left.
// A name is a whole token (`--db-password`, `_authToken`, `db.password`); a
// `(`, `[` or `,` separates only a quoted value, so `[token, setToken]` in
// command output is not a pair.
const NET_KEY = /(?<![\w$.-])-{0,2}([A-Za-z_$][\w$.-]{0,100})/g
const NET_TAIL =
  /(?:[ \t]|\\\r?\n|=>|->|:=|[=:"'`>]|<!\[CDATA\[|[([,](?=[ \t]*["'`])){1,40}((?:[^\s"'`;,<\]]|\](?!\]>)){1,4096})/dy
// `.pgpass`: host:port:database:user:password, one entry a line.
const PGPASS_LINE = /^(?![ \t]*#)(?:[^:\n]*:){4}([^\n]+)$/dgm

// `key=value` pairs inside a value: a connection string, a query string.
const INNER = /(?<![\w.$-])([A-Za-z_][\w.-]{0,100})[ \t]*[=:][ \t]*([^\s;&,'"<>]+)/dg
// Configuration lines. Each starts at a line start, every run is bounded or
// ends at the line's end, and no quantified group nests another: linear.
const ENV_LINE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][\w.-]{0,200})[ \t]*=([^\n]*)$/dgm
const INI_LINE = /^[ \t]*["']?([A-Za-z_$][\w.$-]{0,200})["']?[ \t]*(?:[:?+]?=|:)([^\n]*)$/dgm
const YAML_LINE =
  /^([ \t]*)(?:-[ \t]+)?["']?([^\s:"'#-][^:"'\n]{0,200}?)["']?[ \t]*:((?:[ \t][^\n]*)?)$/dgm
const YAML_SCALAR = /^[ \t]*(?!-[ \t]|-$|#|---|\.\.\.)([^\n]+)$/dgm
const YAML_ITEM = /^[ \t]*-[ \t]+([^\n]*)$/dgm
const SHELL_PAIR =
  /(?<![^\s;&|(])(?:export[ \t]+)?([A-Za-z_]\w{0,200})=("[^"\n]*"|'[^'\n]*'|[^\s;&|]*)/dg
const DOCKER_ENV = /^[ \t]*ENV[ \t]+([A-Za-z_]\w{0,200})[ \t]+([^\n=]+)$/dgm
const XML_TEXT = /<([A-Za-z_][\w.:-]{0,100})([^<>]{0,2000})>([^<]+)<\//dg
// A comment starts after a space; a glued `#` is part of the value.
const HASH = /[ \t]#/
const HASH_OR_SEMICOLON = /[ \t][#;]/
const XML_KEY_ATTR = /(?:^|\s)(?:key|name|id)[ \t]*=[ \t]*["']([^"']*)["']/g

/** The value in `raw` at `offset`: its comment and quotes taken off, and in
 *  YAML its anchor and tag; a block header has its value on the lines below. */
function trimmed(
  raw: string,
  offset: number,
  comment: RegExp | null,
  yaml = false,
  stop: RegExp | null = null
): { start: number; end: number; quoted: boolean } | null {
  let end = raw.length
  for (const re of [comment, stop]) {
    const at = re ? raw.slice(0, end).search(re) : -1
    if (at !== -1) end = at
  }
  let start = 0
  while (start < end && /\s/.test(raw[start]!)) start++
  while (end > start && /\s/.test(raw[end - 1]!)) end--
  if (yaml) {
    const props = /^(?:[&!]\S*[ \t]+)*(?:[&!]\S*$)?/.exec(raw.slice(start, end))![0]
    start += props.length
    if (/^[|>][-+]?\d?[-+]?$/.test(raw.slice(start, end))) return null
  }
  const quoted = end - start >= 2 && /["'`]/.test(raw[start]!) && raw[end - 1] === raw[start]
  if (quoted) {
    // A TOML or Python triple-quoted string is quoted by all three.
    const q = raw[start]!.repeat(3)
    const triple = end - start >= 6 && raw.startsWith(q, start) && raw.startsWith(q, end - 3)
    start += triple ? 3 : 1
    end -= triple ? 3 : 1
  }
  return end > start ? { start: offset + start, end: offset + end, quoted } : null
}

/** Every value position in `text`, sorted by start. Spans may nest: a
 *  connection string's `password=...` lies inside its string. */
export function valueSpans(text: string, scan: ValueScan = {}): ValueSpan[] {
  const out: ValueSpan[] = []
  const kind = scan.kind
  const calls = kind === 'code' || scan.code === true
  // Under a credential key a value is never a readable path.
  const add = (start: number, end: number, keyed: boolean, quoted: boolean, module = false) => {
    const value = text.slice(start, end)
    const credential = keyed && secretShaped(value, quoted, calls)
    out.push({ start, end, value, credential, path: !keyed && (module || PATH.test(value)) })
  }
  const strings: readonly { start: number; end: number; module?: boolean }[] =
    scan.strings ??
    [...text.matchAll(QUOTED)].map((m) => ({
      start: m.index! + 1,
      end: m.index! + 1 + m[2]!.length,
    }))
  for (const s of strings) {
    // A module is a path; a shell's backticks run a command.
    const shell = kind === 'shell' || kind === 'dotenv'
    const command = shell && (text[s.start - 1] === '`' || inCommand(text, s.start))
    const keyed = !s.module && !command && credentialBefore(text, s.start - 1, scan.language)
    add(s.start, s.end, keyed, true, s.module)
  }

  const any = kind === undefined
  // In text of no known kind a line holds several pairs: `,` and `;` end one.
  const end = any ? /[,;]/ : null
  const line = (re: RegExp, key: number, value: number, comment: RegExp | null) => {
    for (const m of text.matchAll(re)) {
      const raw = m[value]
      if (raw === undefined) continue
      const at = m.indices![value]![0]
      const v = trimmed(raw, at, comment, false, end)
      if (v) add(v.start, v.end, key > 0 && CREDENTIAL.test(m[key]!), v.quoted)
    }
  }
  // A config file written in its neighbour's syntax keeps its values too: a
  // `key: value` in a dotenv file, a `KEY=value` in YAML.
  if (any || kind === 'dotenv' || kind === 'yaml') line(ENV_LINE, 1, 2, HASH)
  if (any || kind === 'ini' || kind === 'dotenv') line(INI_LINE, 1, 2, HASH_OR_SEMICOLON)
  if (any || kind === 'shell') {
    line(SHELL_PAIR, 1, 2, null)
    line(DOCKER_ENV, 1, 2, HASH)
  }
  if (any || kind === 'yaml') {
    // A list item is a value; a `KEY=value` in it is found as a pair inside.
    line(YAML_ITEM, 0, 1, HASH)
    // A key with nothing after it may have its value on the line below; a
    // k8s env entry's `value:` belongs to the `name:` above it.
    let previous: { indent: number; key: string; value: string } | null = null
    const keys = new Set<number>()
    for (const m of text.matchAll(YAML_LINE)) {
      keys.add(m.index!)
      const indent = m[1]!.length
      const key = m[2]!
      const named = previous && /^value$/i.test(key) && /^name$/i.test(previous.key)
      const credential =
        CREDENTIAL.test(key) || (named === true && CREDENTIAL.test(previous!.value))
      const raw = m[3] ?? ''
      const v = trimmed(raw, m.indices![3]?.[0] ?? m.index! + m[0].length, HASH, true, end)
      if (v) add(v.start, v.end, credential, v.quoted)
      else {
        const next = m.index! + m[0].length + 1
        const nl = text.indexOf('\n', next)
        const below = text.slice(next, nl === -1 ? text.length : nl)
        const lead = below.length - below.trimStart().length
        if (lead > indent && !/^[ \t]*(?:-|#|[^\s:]+:(?:\s|$))/.test(below)) {
          const w = trimmed(below, next, HASH, true)
          if (w) add(w.start, w.end, credential, w.quoted)
        }
      }
      previous = { indent, key, value: v ? text.slice(v.start, v.end) : '' }
    }
    // Any other line of a YAML file is a scalar: a block's body, a plain
    // value over several lines, a document that is one value.
    if (kind === 'yaml')
      for (const m of text.matchAll(YAML_SCALAR)) {
        if (keys.has(m.index!)) continue
        const v = trimmed(m[1]!, m.indices![1]![0], HASH, true)
        if (v) add(v.start, v.end, false, v.quoted)
      }
  }
  // Element text, in every kind: XML embedded in code, JSX.
  {
    for (const m of text.matchAll(XML_TEXT)) {
      const [s] = m.indices![3]!
      const v = trimmed(m[3]!, s, null)
      if (!v) continue
      let credential = CREDENTIAL.test(m[1]!)
      for (const a of m[2]!.matchAll(XML_KEY_ATTR)) credential ||= CREDENTIAL.test(a[1]!)
      add(v.start, v.end, credential, false)
    }
  }
  // A bare name after a credential key, in text of no known kind.
  if (any) {
    for (const m of text.matchAll(BARE)) {
      const [s, e] = m.indices![2]!
      const value = m[2]!
      if (!CREDENTIAL.test(m[1]!) || !secretShaped(value, false) || keyword(value, scan.language))
        continue
      out.push({ start: s, end: e, value, credential: true, path: false, bare: true })
    }
  }
  if (kind !== 'code') {
    let covered = 0
    for (const k of text.matchAll(NET_KEY)) {
      const keyEnd = k.index! + k[0].length
      // A placeholder already in the text (`__REDACTED_CREDENTIAL_1__`) names nothing.
      if (k.index! < covered || /__[A-Z]/.test(k[1]!) || !CREDENTIAL.test(k[1]!)) continue
      NET_TAIL.lastIndex = keyEnd
      const m = NET_TAIL.exec(text)
      if (!m) continue
      const [s, e] = m.indices![1]!
      const value = m[1]!
      covered = e
      if (!secretShaped(value, false, calls) || keyword(value, scan.language)) continue
      // A call, a `${{ }}` expression or a `<placeholder>` runs on past the
      // value's delimiter: read on to the end of the line, at most 512
      // characters, so many keys on one long line stay linear.
      if (/^[$<]/.test(value) || calls) {
        // Inside quotes, up to the closing one.
        const quote = /["'`]/.test(text[s - 1] ?? '') ? text[s - 1]! : '\n'
        const rest = text
          .slice(s, s + 512)
          .split('\n', 1)[0]!
          .split(quote, 1)[0]!
          .trim()
        if (/^[$<]/.test(value) && !secretShaped(rest, false)) continue
        if (calls && CALL_OR_MEMBER.test(rest)) continue
      }
      // A shell's backticks run a command; YAML's anchor, tag and block
      // indicator stand before a value, which the YAML grammar reads.
      if ((kind === 'shell' || kind === 'dotenv') && text[s - 1] === '`') continue
      if (kind === 'yaml' && /^(?:[&!]\S*|[|>][-+]?\d?[-+]?)$/.test(value)) continue
      // A search result's `path:12:` or `path-12-` is a file and its line.
      if (/^\d+[:-]/.test(value)) continue
      // A flag after the name (`--password --verbose`, "pass --dry-run") is
      // the next option, not this one's value.
      if (/^-{1,2}[A-Za-z_]/.test(value)) continue
      out.push({ start: s, end: e, value, credential: true, path: false })
    }
  }
  if (kind === 'pgpass')
    for (const m of text.matchAll(PGPASS_LINE)) {
      const [s, e] = m.indices![1]!
      if (secretShaped(m[1]!, false))
        out.push({ start: s, end: e, value: m[1]!, credential: true, path: false })
    }
  // Pairs inside every value found so far.
  for (const span of out.slice()) {
    if (span.credential) continue
    for (const m of span.value.matchAll(INNER)) {
      if (!CREDENTIAL.test(m[1]!)) continue
      const [s, e] = m.indices![2]!
      add(span.start + s, span.start + e, true, false)
    }
  }
  // A value written as one wins over the same text read as a bare name.
  return out.sort(
    (a, b) => a.start - b.start || b.end - a.end || Number(!!a.bare) - Number(!!b.bare)
  )
}

const BARE =
  /(?<![\w$.-])["'`]?([A-Za-z_$][\w$.-]{0,100})["'`]?\]?[ \t]*(?:=>|:=|=(?![=~>])|:(?!:))[ \t]*([A-Za-z_$][\w$]{0,255})(?=[ \t]*(?:[,;})\]#<]|\/\/|\r?$))/dgm

/** The credential values among `spans`, never overlapping: the first wins. */
export function credentialsAmong(spans: readonly ValueSpan[]): ValueSpan[] {
  const out: ValueSpan[] = []
  for (const s of spans)
    if (s.credential && (!out.length || s.start >= out[out.length - 1]!.end)) out.push(s)
  return out
}
