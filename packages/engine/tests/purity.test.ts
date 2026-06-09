import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Privacy invariant (plan controls P1 + P2). The engine processes users' real
// source code; it must stay a pure, local transform — no network, no telemetry,
// no environment reads, and zero runtime dependencies. These checks fail CI if a
// future change (or a malicious PR) tries to add an exfiltration path.

const src = readFileSync(new URL('../src/engine.ts', import.meta.url), 'utf8')
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
    for (const token of banned) {
      expect(src.includes(token), `engine.ts must not reference ${token}`).toBe(false)
    }
  })

  it('reads no environment or process globals', () => {
    expect(src.includes('process.env')).toBe(false)
    expect(src.includes('process.argv')).toBe(false)
  })

  it('declares zero runtime dependencies', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toHaveLength(0)
  })
})
