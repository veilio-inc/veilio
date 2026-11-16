import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/engine.js'
import type { SymbolMap } from '../src/types.js'

// A model is asked to echo placeholders verbatim and may do anything but. These
// tests pin the four ways that goes wrong, because the restored text looks
// equally confident in all of them.
const SOURCE = [
  'function validateSessionToken(userToken) {',
  '  return authService.checkQuayToken(userToken)',
  '}',
].join('\n')

function roundTrip(mangle: (anonymized: string) => string) {
  const { anonymized, map } = anonymize(SOURCE)
  return restore(mangle(anonymized), map, { strip: 'none' })
}

describe('restore — report', () => {
  it('reports every placeholder resolved when the model behaves', () => {
    const { restored, report } = roundTrip((a) => a)

    expect(restored).toBe(SOURCE)
    expect(report.missing).toEqual([])
    expect(report.unresolved).toEqual([])
    expect(report.resolved).toHaveLength(4)
  })

  it('reports a renamed placeholder as missing — the silent case', () => {
    // The dangerous one: the model invented a readable name, so nothing
    // placeholder-shaped is left to detect and the output looks like working
    // code. Absence from the response is the only available signal.
    const { restored, report } = roundTrip((a) => a.replace('__FN__1', 'processToken'))

    expect(restored).toContain('function processToken(')
    expect(restored).not.toContain('validateSessionToken')
    expect(report.missing).toEqual(['__FN__1'])
    expect(report.unresolved).toEqual([])
  })

  it('reports an invented placeholder as unresolved', () => {
    const { report } = roundTrip((a) => a.replace('__VAR__1', '__VAR__9'))

    expect(report.unresolved).toEqual(['__VAR__9'])
    expect(report.missing).toEqual(['__VAR__1'])
  })

  it('reports a re-cased placeholder as missing, not unresolved', () => {
    // `__fn__1` is deliberately NOT flagged as a mangled placeholder: the scan
    // that would catch it also catches every Python dunder. Under-reporting
    // here is the price of not crying wolf — see buildRestoreReport.
    const { report } = roundTrip((a) => a.replace('__FN__1', '__fn__1'))

    expect(report.unresolved).toEqual([])
    expect(report.missing).toEqual(['__FN__1'])
  })

  it('does not report redaction tokens as unresolved', () => {
    // Credentials are redacted one-way and never enter the map, so surviving
    // the round trip is correct behaviour rather than a failed restore.
    const { anonymized, map } = anonymize('const apiKey = "sk-live-9f2a"')
    expect(anonymized).toContain('__REDACTED_')

    const { report } = restore(anonymized, map, { strip: 'none' })
    expect(report.unresolved).toEqual([])
  })

  it('treats a partial reply as missing rather than broken', () => {
    // A model answering about one function legitimately omits the rest of the
    // file. Callers are expected to present `missing` as information.
    const { anonymized, map } = anonymize(SOURCE)
    const oneLine = anonymized.split('\n')[0]

    const { report } = restore(oneLine, map, { strip: 'none' })
    expect(report.resolved.length).toBeGreaterThan(0)
    expect(report.missing.length).toBeGreaterThan(0)
    expect(report.unresolved).toEqual([])
  })

  it('dedupes a repeated unresolved token and keeps first-seen order', () => {
    const map: SymbolMap = {}
    const { report } = restore('__CLS__7 __VAR__3 __CLS__7', map, { strip: 'none' })

    expect(report.unresolved).toEqual(['__CLS__7', '__VAR__3'])
  })

  it('reports nothing for an empty map and clean text', () => {
    const { report } = restore('const a = 1', {}, { strip: 'none' })

    expect(report).toEqual({ resolved: [], missing: [], unresolved: [], altered: [] })
  })

  it('is unaffected by comment stripping', () => {
    const { anonymized, map } = anonymize(SOURCE)
    const withNoise = `// TODO: handle refunds\n${anonymized}`

    const { report, strippedCount } = restore(withNoise, map)
    expect(strippedCount).toBeGreaterThan(0)
    expect(report.missing).toEqual([])
    expect(report.unresolved).toEqual([])
  })
})

// A map may be someone else's. Only what masking could have written is put
// back: a placeholder key with a text value, never a redaction token.
describe('restore substitutes only placeholders', () => {
  const quiet = (text: string, map: unknown) => restore(text, map as SymbolMap, { strip: 'none' })

  it('leaves a word, one letter and an operator alone, and still restores the placeholder', () => {
    const r = quiet('call fetch(url) with a and __VAR__1', {
      fetch: 'send',
      a: 'X',
      '(': '[',
      __VAR__1: 'total',
    })
    expect(r.restored).toBe('call fetch(url) with a and total')
    expect(r.report.resolved).toEqual(['__VAR__1'])
    // An ignored key is not an entry the response failed to use.
    expect(r.report.missing).toEqual([])
  })

  it('ignores the empty key', () => {
    expect(quiet('hello __VAR__1', { '': 'Y', __VAR__1: 'total' }).restored).toBe('hello total')
    expect(quiet('hello', { '': 'Y' }).restored).toBe('hello')
  })

  it('never restores a redaction token, whatever the map says', () => {
    const r = quiet('key = __REDACTED_SECRET__ and __REDACTED_SECRET__1', {
      __REDACTED_SECRET__: 'opened',
      __REDACTED_SECRET__1: 'opened',
    })
    expect(r.restored).toBe('key = __REDACTED_SECRET__ and __REDACTED_SECRET__1')
    expect(r.report.missing).toEqual([])
  })

  it('ignores an entry whose value is not text, and does not throw', () => {
    for (const value of [5, null, ['x'], { a: 1 }, true]) {
      const r = quiet('a __VAR__1 and __VAR__2', { __VAR__1: value, __VAR__2: 'total' })
      expect(r.restored).toBe('a __VAR__1 and total')
      expect(r.report.unresolved).toEqual(['__VAR__1'])
    }
    // The value that used to throw: one that holds no `includes`.
    expect(() => quiet('__VAR__1', { __VAR__1: 5 })).not.toThrow()
  })

  it('restores every family of placeholder the tools write, as before', () => {
    const map = {
      __CLS__1: 'PaymentGateway',
      __FN__2: 'chargeCard',
      __VAR__3: 'amountDue',
      __PKG__4: 'billing-core',
      __STR__5: 'ledger',
      __MANUAL__6: 'Jan Kowalski',
      __LOCAL_K7Q2XA_VAR__7: 'localTotal',
      __H_0123456789ABCDEF__8: 'hashedBase',
      __CODENAME__: 'phoenix',
      __CODENAME__9: 'griffin',
      __IBAN__10: 'GB82 WEST 1234 5698 7654 32',
      __P11__: 'legacyName',
    }
    const text = Object.keys(map).join(' | ')
    const r = quiet(text, map)
    expect(r.restored).toBe(Object.values(map).join(' | '))
    expect(r.report.resolved).toEqual(Object.keys(map))
  })

  it('still reads a value that holds a placeholder through', () => {
    const r = quiet('use __VAR__2', { __MANUAL__1: 'Acme', __VAR__2: '__MANUAL__1_API_URL' })
    expect(r.restored).toBe('use Acme_API_URL')
  })
})
