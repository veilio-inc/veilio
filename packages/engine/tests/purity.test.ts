import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  anonymize,
  restore,
  detectSecrets,
  scanSecrets,
  extractIdentifiers,
  guessLanguage,
  buildLegend,
  withAiPreamble,
  LANGUAGES,
} from '../src/index.js'

// Privacy invariant (plan controls P1 + P2). The engine processes users' real
// source code; it must stay a pure, local transform — no network, no telemetry,
// no environment reads, and zero runtime dependencies. These checks fail CI if a
// future change (or a malicious PR) tries to add an exfiltration path.

// Every engine source, not just engine.ts. The credential detector in
// secrets.ts sees more sensitive material than anything else in the package —
// exempting it from the invariant would be exactly backwards.
const SOURCES = [
  'engine.ts',
  'languages.ts',
  'product.ts',
  'secrets.ts',
  'types.ts',
  'index.ts',
] as const

const sources = SOURCES.map((name) => ({
  name,
  text: readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'),
}))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Remove comments, keep everything else — including string literals.
 *
 *  Deliberately a small state machine rather than a regex. A regex that strips
 *  `//` to end-of-line also truncates at the `//` inside a URL or a string, and
 *  silently swallowing a line is how a scan like this gains a blind spot. */
function stripComments(text: string): string {
  let out = ''
  let i = 0
  type State = 'code' | 'line' | 'block' | "'" | '"' | '`'
  let state: State = 'code'

  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]

    if (state === 'code') {
      if (c === '/' && next === '/') ((state = 'line'), (i += 2))
      else if (c === '/' && next === '*') ((state = 'block'), (i += 2))
      else if (c === "'" || c === '"' || c === '`') ((state = c), (out += c), i++)
      else ((out += c), i++)
    } else if (state === 'line') {
      if (c === '\n') ((state = 'code'), (out += c), i++)
      else i++
    } else if (state === 'block') {
      if (c === '*' && next === '/') ((state = 'code'), (i += 2))
      else ((out += c === '\n' ? '\n' : ''), i++)
    } else {
      // Inside a string: honour escapes so a trailing backslash cannot end it.
      if (c === '\\') ((out += c + (next ?? '')), (i += 2))
      else if (c === state) ((state = 'code'), (out += c), i++)
      else ((out += c), i++)
    }
  }
  return out
}

describe('engine purity (privacy invariant)', () => {
  it('makes no network calls', () => {
    const banned = [
      'fetch(',
      'XMLHttpRequest',
      'sendBeacon',
      'WebSocket',
      "from 'http'",
      "from 'https'",
      "from 'net'",
      "from 'dns'",
      'require("http")',
      "require('http')",
    ]
    for (const { name, text } of sources) {
      for (const token of banned) {
        expect(text.includes(token), `${name} must not reference ${token}`).toBe(false)
      }
    }
  })

  it('touches no filesystem', () => {
    const banned = ["from 'fs'", "from 'node:fs'", 'readFileSync', 'writeFileSync']
    for (const { name, text } of sources) {
      for (const token of banned) {
        expect(text.includes(token), `${name} must not reference ${token}`).toBe(false)
      }
    }
  })

  it('reads no environment or process globals', () => {
    for (const { name, text } of sources) {
      expect(text.includes('process.env'), `${name} reads process.env`).toBe(false)
      expect(text.includes('process.argv'), `${name} reads process.argv`).toBe(false)
    }
  })

  it('never logs — a console call in the engine would print users’ real code', () => {
    for (const { name, text } of sources) {
      expect(text.includes('console.'), `${name} must not log`).toBe(false)
    }
  })

  it('never reaches for a storage or execution global', () => {
    // Scanned with comments removed. This engine documents what it looks for in
    // *users'* code, so prose legitimately mentions `import(...)` and friends —
    // and a token inside a comment executes nothing. String literals are kept,
    // so `globalThis["fetch"]` is still caught: the telltale part is outside the
    // quotes.
    const banned = [
      'eval(',
      'new Function',
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'document.cookie',
      'EventSource',
      'postMessage',
      'importScripts',
      'globalThis[',
      'window[',
      'import(',
    ]
    for (const { name, text } of sources) {
      const code = stripComments(text)
      for (const token of banned) {
        expect(code.includes(token), `${name} must not reference ${token}`).toBe(false)
      }
    }
  })

  it('declares zero runtime dependencies', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toHaveLength(0)
  })
})

describe('stripComments (the scan is only as good as this)', () => {
  it('removes line and block comments', () => {
    expect(stripComments('a // localStorage\nb')).not.toContain('localStorage')
    expect(stripComments('a /* localStorage */ b')).not.toContain('localStorage')
    expect(stripComments('/** localStorage */\ncode')).not.toContain('localStorage')
  })

  it('keeps the code around them', () => {
    expect(stripComments('const a = 1 // note\nconst b = 2')).toContain('const a = 1')
    expect(stripComments('const a = 1 // note\nconst b = 2')).toContain('const b = 2')
  })

  it('does not treat // inside a string as a comment', () => {
    // The regex version of this function truncates here, taking any real code
    // after it out of the scan entirely.
    const src = 'const u = "https://x.example" ; localStorage.getItem("k")'
    expect(stripComments(src)).toContain('localStorage')
  })

  it('keeps string contents, so an obfuscated global is still visible', () => {
    expect(stripComments('globalThis["fetch"]')).toContain('globalThis[')
  })

  it('handles an escaped quote inside a string', () => {
    const src = 'const s = "a\\"b" ; localStorage.x'
    expect(stripComments(src)).toContain('localStorage')
  })

  it('handles a comment marker inside a template literal', () => {
    expect(stripComments('const t = `// not a comment` ; localStorage.x')).toContain('localStorage')
  })

  it('preserves line structure so failures stay locatable', () => {
    expect(stripComments('a\n/* x\ny\n*/\nb').split('\n').length).toBeGreaterThan(2)
  })
})

// ── The executable half ──────────────────────────────────────────────────────
//
// Everything above searches source text, which is worth having and is not a
// guarantee: `globalThis['fet' + 'ch']` and `new Function('return fetch')()`
// both sail past a grep. This half runs the engine with those globals replaced
// by recording accessors, so *any* path to them is caught — computed property
// names, indirect eval and all — because each one is ultimately a property read
// on the global object.
//
// Module evaluation is covered too, and had to be: the first version of this
// suite trapped only calls, and a probe that captured `fetch` at module scope
// passed it. Capture-once-use-later is the obvious way to write the thing this
// gate exists to stop, so the last test here re-imports the engine with the
// traps already installed.

const FORBIDDEN_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'document',
  'window',
  'importScripts',
  'require',
] as const

/** Run `fn` with every forbidden global replaced by a recording accessor.
 *
 *  `fn` must be synchronous. That is not a limitation but the point: nothing
 *  else can interleave, so anything recorded was reached by the engine and not
 *  by the test runner. */
function withTraps<T>(fn: () => T): { result: T; touched: string[] } {
  const touched: string[] = []
  const saved = new Map<string, PropertyDescriptor | undefined>()

  for (const name of FORBIDDEN_GLOBALS) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        touched.push(name)
        return undefined
      },
    })
  }

  try {
    return { result: fn(), touched }
  } finally {
    for (const name of FORBIDDEN_GLOBALS) {
      const original = saved.get(name)
      if (original) Object.defineProperty(globalThis, name, original)
      else delete (globalThis as Record<string, unknown>)[name]
    }
  }
}

/** A workload that exercises the paths a user's code actually travels. */
function fullWorkload(): void {
  const source = [
    '// escalated by Kowalska, acct 88412037',
    'const apiKey = "sk_live_4eC39HqLyjWDarjtT1zdp7dc"',
    'class InvoiceLedger {',
    '  settleInvoice(discountRate) { return this.apply(discountRate) }',
    '}',
  ].join('\n')

  const { anonymized, map } = anonymize(source, { manual: ['Kowalska'] })
  restore(anonymized, map)
  restore(anonymized, map, { strip: 'none' })
  buildLegend(map, anonymized)
  withAiPreamble(anonymized, map)

  detectSecrets(source)
  scanSecrets(source)
  guessLanguage(source)
  for (const language of LANGUAGES) extractIdentifiers(source, language)
}

describe('engine purity (executed, not grepped)', () => {
  it('the trap actually fires — otherwise this suite passes vacuously', () => {
    // Without this, a broken defineProperty would turn every assertion below
    // into a test that cannot fail.
    const { touched } = withTraps(() => {
      void (globalThis as Record<string, unknown>)['fetch']
      void (globalThis as Record<string, unknown>)['localStorage']
    })

    expect(touched).toContain('fetch')
    expect(touched).toContain('localStorage')
  })

  it('restores the real globals afterwards', () => {
    const before = typeof globalThis.fetch
    withTraps(() => undefined)

    expect(typeof globalThis.fetch).toBe(before)
  })

  it('touches no forbidden global across a full anonymize/restore cycle', () => {
    const { touched } = withTraps(fullWorkload)

    expect(touched).toEqual([])
  })

  it('touches no forbidden global while the module itself is evaluated', async () => {
    // A reference grabbed at module scope is the natural way to write an
    // exfiltration path: capture once on load, use it later from a function
    // that looks ordinary. Trapping only calls misses it entirely — verified,
    // because an earlier version of this suite did exactly that and passed.
    //
    // Nothing else runs in this window: the import is the only await, and the
    // runner touches none of these globals while resolving it.
    const touched: string[] = []
    const saved = new Map<string, PropertyDescriptor | undefined>()

    for (const name of FORBIDDEN_GLOBALS) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          touched.push(name)
          return undefined
        },
      })
    }

    try {
      // Static specifier: Vite cannot analyse a computed one, and a cache-busting
      // query throws before the trap ever sees anything. resetModules is what
      // forces the re-evaluation.
      vi.resetModules()
      await import('../src/index.js')
    } finally {
      for (const name of FORBIDDEN_GLOBALS) {
        const original = saved.get(name)
        if (original) Object.defineProperty(globalThis, name, original)
        else delete (globalThis as Record<string, unknown>)[name]
      }
    }

    expect(touched).toEqual([])
  })

  it('touches nothing even when the input is hostile', () => {
    // Input is the one thing an attacker controls, so it should not be able to
    // steer the engine into a global either.
    const { touched } = withTraps(() => {
      for (const nasty of [
        '${globalThis.fetch("//x")}',
        '`${localStorage.setItem("a","b")}`',
        'eval("fetch(1)")',
        '\u0000\uFEFF\u202E\u200B',
        'a'.repeat(50_000),
      ]) {
        const { anonymized, map } = anonymize(nasty)
        restore(anonymized, map)
        detectSecrets(nasty)
      }
    })

    expect(touched).toEqual([])
  })
})
