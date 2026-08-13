import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/engine.js'
import type { SymbolMap } from '../src/types.js'

// A model is asked to echo placeholders verbatim and may do anything but. These
// tests pin the four ways that goes wrong, because the restored text looks
// equally confident in all of them.
const SOURCE = [
  'function validateSessionToken(userToken) {',
  '  return authService.check(userToken)',
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

    expect(report).toEqual({ resolved: [], missing: [], unresolved: [] })
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
