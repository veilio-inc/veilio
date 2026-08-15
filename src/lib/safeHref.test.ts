import { describe, it, expect } from 'vitest'
import { safeHref, isExternal } from './safeHref.js'

describe('safeHref — allowed', () => {
  it('passes http and https', () => {
    expect(safeHref('https://veilio.dev')).toBe('https://veilio.dev')
    expect(safeHref('http://example.com/x?y=1#z')).toBe('http://example.com/x?y=1#z')
  })

  it('passes mailto, which the notices use for contact addresses', () => {
    expect(safeHref('mailto:support@veilio.dev')).toBe('mailto:support@veilio.dev')
  })

  it('passes site-relative paths, including the rewritten ./doc.md links', () => {
    expect(safeHref('/legal/privacy')).toBe('/legal/privacy')
    expect(safeHref('/')).toBe('/')
  })

  it('passes in-page anchors', () => {
    expect(safeHref('#minimum-age')).toBe('#minimum-age')
  })

  it('is not fooled by case in an allowed scheme', () => {
    expect(safeHref('HTTPS://veilio.dev')).toBe('HTTPS://veilio.dev')
  })
})

describe('safeHref — refused', () => {
  it('refuses javascript:', () => {
    // The whole point. React 18 warns and renders it anyway.
    expect(safeHref('javascript:alert(1)')).toBeNull()
  })

  it('refuses javascript: in any casing', () => {
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeNull()
    expect(safeHref('JAVASCRIPT:alert(1)')).toBeNull()
  })

  it('refuses javascript: hidden behind leading whitespace', () => {
    // Browsers strip leading whitespace before resolving the scheme.
    expect(safeHref('  javascript:alert(1)')).toBeNull()
    expect(safeHref('\n\tjavascript:alert(1)')).toBeNull()
  })

  it('refuses javascript: split by an embedded control character', () => {
    // The bypass a naive `startsWith` check misses: the URL parser removes tabs,
    // newlines and carriage returns from anywhere before finding the ':'.
    expect(safeHref('java\tscript:alert(1)')).toBeNull()
    expect(safeHref('java\nscript:alert(1)')).toBeNull()
    expect(safeHref('java\rscript:alert(1)')).toBeNull()
    expect(safeHref('jav\ta\nscri\rpt:alert(1)')).toBeNull()
  })

  it('refuses data:, which can carry a whole HTML document', () => {
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(safeHref('data:text/html;base64,PHNjcmlwdD4=')).toBeNull()
  })

  it('refuses other executable and opaque schemes', () => {
    expect(safeHref('vbscript:msgbox(1)')).toBeNull()
    expect(safeHref('blob:https://example.com/uuid')).toBeNull()
    expect(safeHref('file:///etc/passwd')).toBeNull()
  })

  it('refuses protocol-relative URLs that look local', () => {
    // `//evil.example` navigates off-site while reading as a relative path —
    // the same confusion as the advisory against this app's router.
    expect(safeHref('//evil.example/phish')).toBeNull()
    expect(safeHref('//evil.example')).toBeNull()
  })

  it('refuses an empty or whitespace-only href', () => {
    expect(safeHref('')).toBeNull()
    expect(safeHref('   ')).toBeNull()
    expect(safeHref('\t\n')).toBeNull()
  })

  it('refuses a bare relative path rather than guessing at it', () => {
    expect(safeHref('terms.md')).toBeNull()
    expect(safeHref('../secrets')).toBeNull()
  })
})

describe('safeHref — normalisation', () => {
  it('returns the normalised form, not the original', () => {
    // Returning the original would mean testing one string and rendering
    // another, which is how a check like this gets quietly bypassed.
    expect(safeHref('  https://veilio.dev  ')).toBe('https://veilio.dev')
    expect(safeHref('https://veilio.dev/\n')).toBe('https://veilio.dev/')
  })

  it('never returns a value that still parses as a denied scheme', () => {
    const attempts = [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'JAV\nASCRIPT:alert(1)',
      'data:text/html,x',
    ]
    for (const raw of attempts) {
      const out = safeHref(raw)
      expect(out, `${JSON.stringify(raw)} must be refused`).toBeNull()
    }
  })
})

describe('isExternal', () => {
  it('is true for http(s) and false for everything else allowed', () => {
    expect(isExternal('https://veilio.dev')).toBe(true)
    expect(isExternal('http://example.com')).toBe(true)
    expect(isExternal('/legal/terms')).toBe(false)
    expect(isExternal('#anchor')).toBe(false)
    expect(isExternal('mailto:support@veilio.dev')).toBe(false)
  })
})
