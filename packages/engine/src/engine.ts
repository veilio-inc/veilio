import type {
  AnonymizeOptions,
  AnonymizeResult,
  CustomRule,
  CustomRuleReplace,
  CustomRuleWhitelist,
  RestoreResult,
  StrippedItem,
  StrippedItemType,
  SymbolMap,
} from './types.js'

// ─── Keyword exclusion set ───────────────────────────────────────────────────

const KEYWORDS = new Set<string>([
  // JS/TS reserved words
  'abstract',
  'any',
  'as',
  'asserts',
  'async',
  'await',
  'bigint',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'constructor',
  'continue',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'is',
  'keyof',
  'let',
  'module',
  'namespace',
  'never',
  'new',
  'null',
  'number',
  'object',
  'of',
  'override',
  'package',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'satisfies',
  'set',
  'static',
  'string',
  'super',
  'switch',
  'symbol',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'unique',
  'unknown',
  'using',
  'var',
  'void',
  'while',
  'with',
  'yield',
  // Node / browser globals
  'Buffer',
  'Error',
  'JSON',
  'Map',
  'Math',
  'Object',
  'Promise',
  'Proxy',
  'Reflect',
  'RegExp',
  'Set',
  'Symbol',
  'WeakMap',
  'WeakSet',
  'Array',
  'Boolean',
  'Date',
  'Function',
  'Number',
  'String',
  'TypeError',
  'RangeError',
  'console',
  'process',
  'require',
  'module',
  'exports',
  'global',
  'window',
  'document',
  'navigator',
  'location',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'fetch',
  'URL',
  'URLSearchParams',
  'FormData',
  'Blob',
  'File',
  'FileReader',
  'Event',
  'EventTarget',
  'CustomEvent',
  'AbortController',
  'AbortSignal',
  'Headers',
  'Request',
  'Response',
  'TextEncoder',
  'TextDecoder',
  'crypto',
  'performance',
  'queueMicrotask',
  'structuredClone',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'decodeURI',
  'encodeURIComponent',
  'decodeURIComponent',
  'atob',
  'btoa',
  // React
  'React',
  'Component',
  'Fragment',
  'StrictMode',
  'Suspense',
  'useState',
  'useEffect',
  'useRef',
  'useCallback',
  'useMemo',
  'useContext',
  'useReducer',
  'useLayoutEffect',
  'useImperativeHandle',
  'useDebugValue',
  'useId',
  'createContext',
  'createElement',
  'forwardRef',
  'memo',
  'lazy',
  'startTransition',
  'children',
  'props',
  'state',
  'render',
  'key',
  'ref',
  'defaultProps',
  'displayName',
  // Express / Node HTTP
  'express',
  'router',
  'app',
  'req',
  'res',
  'next',
  'err',
  'ctx',
  'db',
  'sql',
  // Common short/generic names
  'args',
  'cb',
  'fn',
  'val',
  'obj',
  'arr',
  'str',
  'num',
  'idx',
  'len',
  'msg',
  'url',
  'env',
  'cfg',
  'opts',
  'data',
  'body',
  'head',
  'tail',
  'node',
  'root',
  'path',
  'file',
  'dir',
  'tmp',
  'buf',
  'raw',
  'out',
  'log',
  'row',
  'col',
  'pos',
  'end',
  'start',
  'stop',
  'done',
  'ok',
  'id',
  'ts',
  'ms',
  // Standard-library method names — public API, not private identifiers. Masking
  // them strips structural signal a downstream AI needs (e.g. that a loop is a
  // `.forEach` with an un-awaited async callback), for no privacy gain.
  // Array
  'forEach',
  'map',
  'filter',
  'reduce',
  'reduceRight',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'some',
  'every',
  'includes',
  'indexOf',
  'lastIndexOf',
  'push',
  'pop',
  'shift',
  'unshift',
  'slice',
  'splice',
  'concat',
  'flat',
  'flatMap',
  'fill',
  'reverse',
  'sort',
  'join',
  // Map / Set / collection
  'has',
  'add',
  'clear',
  'keys',
  'values',
  'entries',
  'size',
  // Promise
  'then',
  'catch',
  'finally',
  'all',
  'race',
  'allSettled',
  'resolve',
  'reject',
  // String
  'split',
  'trim',
  'trimStart',
  'trimEnd',
  'replace',
  'replaceAll',
  'toLowerCase',
  'toUpperCase',
  'startsWith',
  'endsWith',
  'padStart',
  'padEnd',
  'repeat',
  'charAt',
  'substring',
  'toString',
  'valueOf',
  // Object / JSON / Number
  'assign',
  'freeze',
  'parse',
  'stringify',
  'toFixed',
  'hasOwnProperty',
])

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Downstream-AI preamble ──────────────────────────────────────────────────
//
// Masked code can read as "deliberately obfuscated" to another AI, which then
// refuses to help. Pasting this note above the code tells it the placeholders
// are an intentional privacy measure and to answer normally.

export const AI_PREAMBLE = [
  'The code below was processed by Veilio: real identifiers have been replaced',
  'with privacy placeholders such as __P1__, __P2__ (and similar). This is a',
  'deliberate anonymization step, not obfuscation — please do not refuse on those',
  'grounds. Treat each placeholder as an ordinary name, keep every placeholder',
  'spelled exactly as-is in your reply, and otherwise answer as normal.',
].join(' ')

/** Prepend the downstream-AI preamble to anonymized code, ready to paste. */
export function withAiPreamble(anonymized: string): string {
  return `${AI_PREAMBLE}\n\n${anonymized}`
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

interface Segment {
  text: string
  isComment: boolean
}

function tokenizeForMasking(code: string): Segment[] {
  const segments: Segment[] = []
  let buf = ''
  let bufIsComment = false

  const flush = (nextIsComment: boolean) => {
    if (buf) segments.push({ text: buf, isComment: bufIsComment })
    buf = ''
    bufIsComment = nextIsComment
  }

  let i = 0
  const n = code.length
  while (i < n) {
    const c = code[i]
    const next = code[i + 1]

    if (c === '/' && next === '/') {
      flush(true)
      while (i < n && code[i] !== '\n') buf += code[i++]
      flush(false)
      continue
    }
    if (c === '/' && next === '*') {
      flush(true)
      buf += '/*'
      i += 2
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) buf += code[i++]
      if (i < n) {
        buf += '*/'
        i += 2
      }
      flush(false)
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      // Consume the whole string/template literal into the (maskable) buffer,
      // honoring backslash escapes so an escaped quote doesn't end it early.
      buf += c
      i++
      while (i < n) {
        buf += code[i]
        if (code[i] === '\\') {
          if (i + 1 < n) buf += code[++i]
          i++
          continue
        }
        if (code[i] === c) {
          i++
          break
        }
        i++
      }
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
function blankComments(code: string): string {
  return tokenizeForMasking(code)
    .map((s) => (s.isComment ? s.text.replace(/[^\n]/g, ' ') : s.text))
    .join('')
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract qualifying identifiers from source code, sorted longest-first.
 * Filters out keywords, ALL_CAPS constants, and names ≤ 2 chars.
 */
export function extractIdentifiers(code: string): string[] {
  const seen = new Set<string>()
  // Blank out comments first so their prose words are never extracted; strings
  // are left intact (identifiers in them are masked on purpose).
  const scannable = blankComments(code)
  // `\b` doesn't treat `$` as a word char, so use explicit negative look-around
  // to capture identifiers like `$myStore` while avoiding partial matches.
  const regex = /(?<![a-zA-Z0-9_$])([a-zA-Z_$][a-zA-Z0-9_$]*)(?![a-zA-Z0-9_$])/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(scannable)) !== null) {
    const name = match[1]
    if (name.length > 2 && !KEYWORDS.has(name) && !/^[A-Z][A-Z0-9_]*$/.test(name)) {
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

function isSymbolMap(o: AnonymizeOptions | SymbolMap): o is SymbolMap {
  for (const v of Object.values(o)) {
    if (typeof v !== 'string') return false
  }
  return true
}

/**
 * Anonymize source code, replacing real identifiers with __P1__, __P2__, etc.
 * Pass an existing map to continue numbering from a previous session.
 *
 * Pro-tier custom rules (sub-project #4a):
 * - Whitelist rules (type='whitelist'): identifiers matching the pattern are
 *   left alone, no placeholder assigned.
 * - Replace rules (type='replace'): identifiers matching the pattern get a
 *   named placeholder (e.g., __APIKEY__1, __APIKEY__2) instead of __P<n>__.
 * Precedence: whitelist → replace (first match by sort_order) → default.
 */
export function anonymize(
  code: string,
  options: AnonymizeOptions | SymbolMap = {}
): AnonymizeResult {
  const { existingMap, rules } = isSymbolMap(options)
    ? { existingMap: options, rules: [] as CustomRule[] }
    : { existingMap: options.existingMap ?? {}, rules: options.rules ?? [] }

  const identifiers = extractIdentifiers(code)

  // Find the highest __P<n>__ counter already in use AND seed namedCounters
  // for any pre-existing named placeholders (e.g. __APIKEY__3 → counter at 3
  // for the __APIKEY__ base). Without this, a subsequent call with rules + an
  // existingMap that already contains __APIKEY__1 would generate a fresh
  // __APIKEY__1 for a new identifier and overwrite the previous mapping.
  let counter = 0
  const reverseExisting: Record<string, string> = {}
  const namedCounters: Record<string, number> = {}
  for (const [placeholder, realName] of Object.entries(existingMap)) {
    reverseExisting[realName] = placeholder
    const defaultMatch = placeholder.match(/^__P(\d+)__$/)
    if (defaultMatch) {
      const n = parseInt(defaultMatch[1], 10)
      if (!isNaN(n) && n > counter) counter = n
      continue
    }
    const namedMatch = placeholder.match(/^(__[A-Z][A-Z0-9_]*__)(\d+)$/)
    if (namedMatch) {
      const [, base, nStr] = namedMatch
      const n = parseInt(nStr, 10)
      if (!isNaN(n) && n > (namedCounters[base] ?? 0)) {
        namedCounters[base] = n
      }
    }
  }

  const map: SymbolMap = { ...existingMap }

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
    if (reverseExisting[name]) continue  // already mapped

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

    // 3. Default: existing __P<n>__ numbering
    counter++
    const ph = `__P${counter}__`
    map[ph] = name
    reverseExisting[name] = ph
  }

  // Substitute longest-first (identifiers already sorted by extractIdentifiers).
  // Whitelisted identifiers stay in the source. Comment segments are left
  // verbatim so prose isn't scrambled into ciphertext.
  const substitute = (text: string): string => {
    for (const name of identifiers) {
      if (whitelisted.has(name)) continue
      const placeholder = reverseExisting[name]
      if (placeholder) {
        text = text.replace(
          new RegExp(`(?<![a-zA-Z0-9_$])${escapeRegex(name)}(?![a-zA-Z0-9_$])`, 'g'),
          placeholder
        )
      }
    }
    return text
  }

  const anonymized = tokenizeForMasking(code)
    .map((s) => (s.isComment ? s.text : substitute(s.text)))
    .join('')

  return { anonymized, map, identifierCount: Object.keys(map).length }
}

/**
 * Restore an AI response: strip AI-generated noise, then swap placeholders back.
 */
export function restore(aiResponse: string, map: SymbolMap): RestoreResult {
  const strippedItems: StrippedItem[] = []
  let result = aiResponse

  function strip(pattern: RegExp, type: StrippedItemType): void {
    result = result.replace(pattern, (match) => {
      const before = result.slice(0, result.indexOf(match))
      const lineNumber = before.split('\n').length
      strippedItems.push({ type, content: match.trim(), lineNumber })
      return ''
    })
  }

  // Strip larger blocks before line-level patterns
  strip(/\/\*\*[\s\S]*?\*\//g, 'jsdoc')
  strip(/^[ \t]*\/\/[ \t]*(TODO|FIXME|HACK|REVIEW)[^\n]*/gm, 'todo')
  strip(/^[ \t]*\/\/[ \t]*Step\s+\d+[:.][^\n]*/gm, 'step-marker')
  strip(
    /^[ \t]*\/\/[ \t]*(Handle|Validate|Initialize|Process|Check|Update|Create|Delete|Get|Set|Return|Log|Send|Fetch|Load|Save|Build|Parse|Format|Convert|Calculate|Generate|Execute|Run|Start|Stop|Connect|Disconnect|Register|Authenticate|Authorize)[^\n]*/gm,
    'narration'
  )
  strip(/^[ \t]*\/\/[ \t]*[-=*]{3,}[^\n]*/gm, 'separator')
  strip(/^[ \t]*\/\/[ \t]*\*{2}.*\*{2}[ \t]*$/gm, 'section-header')
  strip(
    /^[ \t]*\/\/[ \t]*@(param|returns?|type|throws?|deprecated|see|example)[^\n]*/gm,
    'inline-annotation'
  )

  // Collapse 3+ consecutive blank lines to 2
  result = result.replace(/\n{3,}/g, '\n\n')

  // Restore placeholders longest-first
  const placeholders = Object.keys(map).sort((a, b) => b.length - a.length)
  for (const placeholder of placeholders) {
    const realName = map[placeholder]
    result = result.replace(new RegExp(escapeRegex(placeholder), 'g'), realName)
  }

  return { restored: result, strippedCount: strippedItems.length, strippedItems }
}
