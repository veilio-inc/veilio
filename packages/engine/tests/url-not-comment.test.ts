import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/engine.js'
import type { Language } from '../src/languages.js'

// `//` opens a comment in C-style languages, and comment prose is left as
// written. The `//` in `file:///Users/…` or `https://host/…` is part of a URL,
// not a comment: treating it as one left the rest of the line - a home
// directory, a client's repo name, a host - unmasked, and counted it as a
// comment besides.

const C_STYLE: Language[] = ['typescript', 'go', 'java', 'csharp', 'rust', 'php', 'c']
// Where a '…' or "…" string cannot contain a raw newline. Only there is a URL's
// `//` read as code: elsewhere a stray apostrophe after the URL could open a
// string that runs into later lines (see "a stray apostrophe" below).
const LINE_BOUNDED: Language[] = ['typescript', 'go', 'c']

describe('a stray apostrophe after a URL', () => {
  // Review finding on the first version of this fix: reading the URL as code
  // let the apostrophe in "user's" open a string that ran into the next line,
  // ended at the quote of '//', and left the rest of that line as a comment.
  it.each(C_STYLE)('%s: cannot turn a later line into a comment', (language) => {
    const text =
      "Fetched https://api.example.com/users/alice - user's profile\n" +
      "const sep = '//'; const ownerName = 'bobSecret'"
    const r = anonymize(text, { language })
    expect(r.anonymized).not.toContain('ownerName')
    expect(r.anonymized).not.toContain('bobSecret')
  })

  it.each(C_STYLE)('%s: cannot open a block comment either', (language) => {
    const text =
      "Fetched https://api.example.com/users/alice - user's profile\n" +
      "const open = '/*'; const ownerName = 'bobSecret'\nconst ownerEmail = 1"
    const r = anonymize(text, { language })
    for (const word of ['ownerName', 'bobSecret', 'ownerEmail']) {
      expect(r.anonymized).not.toContain(word)
    }
  })
})

describe('strings that may span lines still do', () => {
  it('a template literal is one string across lines', () => {
    const code = 'const sqlText = `select clientName\nfrom // not a comment\nacmeOrders`'
    const r = anonymize(code, { language: 'typescript' })
    expect(r.comments.total).toBe(0)
    expect(r.anonymized).not.toContain('acmeOrders')
  })

  it('a backslash-continued string is one string across lines', () => {
    const code = "const greeting = 'hello \\\n// still the string acmeClient'"
    const r = anonymize(code, { language: 'typescript' })
    expect(r.comments.total).toBe(0)
    expect(r.anonymized).not.toContain('acmeClient')
    expect(restore(r.anonymized, r.map).restored).toBe(code)
  })
})

describe('a URL is not a comment', () => {
  it.each(LINE_BOUNDED)('%s: a file:/// frame in a trace is masked', (language) => {
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
