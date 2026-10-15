import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/engine.js'
import type { Language } from '../src/languages.js'

// `//` opens a comment in C-style languages, and comment prose is left as
// written. The `//` in `file:///Users/…` or `https://host/…` is part of a URL,
// not a comment: treating it as one left the rest of the line - a home
// directory, a client's repo name, a host - unmasked, and counted it as a
// comment besides.

const C_STYLE: Language[] = ['typescript', 'go', 'java', 'csharp', 'rust', 'php', 'c']

describe('a URL is not a comment', () => {
  it.each(C_STYLE)('%s: a file:/// frame in a trace is masked', (language) => {
    const line = '    at chargeCustomer (file:///Users/jkowalski/acmeBilling/src/invoice.js:6:10)'
    const r = anonymize(line, { language })
    for (const word of ['jkowalski', 'acmeBilling', 'invoice']) {
      expect(r.anonymized).not.toContain(word)
    }
    expect(r.comments.total).toBe(0)
    expect(restore(r.anonymized, r.map).restored).toBe(line)
  })

  it('a bare file:/// frame is masked and keeps its position', () => {
    const line = '    at file:///Users/jkowalski/acmeBilling/src/invoice.js:3:9'
    const r = anonymize(line, { language: 'typescript' })
    expect(r.anonymized).not.toContain('jkowalski')
    expect(r.anonymized).not.toContain('acmeBilling')
    expect(r.anonymized).toMatch(/^ {4}at file:\/\/\/.*:3:9$/)
  })

  it.each(['https', 'http', 'file', 'wss', 'ssh', 'git'])(
    '%s:// outside a string is masked',
    (scheme) => {
      const line = `connect(${scheme}://acmeHost/clientPortal)`
      const r = anonymize(line, { language: 'typescript' })
      expect(r.anonymized).not.toContain('acmeHost')
      expect(r.anonymized).not.toContain('clientPortal')
      expect(r.anonymized).toContain(`(${scheme}://`)
      expect(r.comments.total).toBe(0)
    }
  )

  it('a URL inside a real comment stays part of the comment', () => {
    const line = 'const total = sumLines(items) // see https://acme.example/billingRules'
    const r = anonymize(line, { language: 'typescript' })
    expect(r.anonymized).toContain('// see https://acme.example/billingRules')
    expect(r.comments.total).toBe(1)
  })

  it.each([
    ['a label', 'outerLoop:// retry from the top'],
    ['default in a switch', 'default:// nothing matched'],
    ['a key ending in a scheme', 'userProfile:// shown on the card'],
    ['an object key', 'retryCount:// how many times'],
    ['a ternary', 'const pick = isReady ? fastPath :// otherwise\n  slowPath'],
  ])('%s followed by a comment is still a comment', (_, code) => {
    const r = anonymize(code, { language: 'typescript' })
    expect(r.comments.total).toBe(1)
  })
})
