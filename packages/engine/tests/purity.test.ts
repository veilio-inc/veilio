import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Privacy invariant (plan controls P1 + P2). The engine processes users' real
// source code; it must stay a pure, local transform — no network, no telemetry,
// no environment reads, and zero runtime dependencies. These checks fail CI if a
// future change (or a malicious PR) tries to add an exfiltration path.

// Every engine source, not just engine.ts. The credential detector in
// secrets.ts sees more sensitive material than anything else in the package —
// exempting it from the invariant would be exactly backwards.
const SOURCES = ['engine.ts', 'languages.ts', 'product.ts', 'secrets.ts', 'types.ts', 'index.ts'] as const

const sources = SOURCES.map((name) => ({
  name,
  text: readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'),
}))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

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

  it('declares zero runtime dependencies', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toHaveLength(0)
  })
})
