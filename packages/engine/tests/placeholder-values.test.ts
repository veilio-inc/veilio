import { describe, it, expect } from 'vitest'
import {
  anonymize,
  decryptTeamMap,
  encryptTeamMap,
  importTeamKey,
  parseSymbolMap,
  placeholderValueRefusal,
  restore,
  toBase64,
  InvalidMapError,
  TeamKeyError,
} from '../src/index.js'

// Spec 085 R2-6, security review: `isName` let a teammate (or Cloud) restore
// operator text such as `x); evil(` into code under an identifier kind. A
// value is now judged by its placeholder's kind, with the grammar the engine
// mints that kind from; a kind the engine does not know is refused.
describe('a placeholder value follows the grammar of its kind', () => {
  it.each([
    'x); evil(',
    'a;b',
    'a(b',
    'a)',
    '"a',
    "a'b",
    'a=b',
    'a\nb',
    'a b',
    '1abc',
    'a.b',
    'ZahlungsTür',
  ])('refuses %j under an identifier kind', (value) => {
    for (const p of [
      '__CLS__1',
      '__FN__2',
      '__VAR__3',
      '__PKG__4',
      '__STR__5',
      '__CODENAME__1',
      '__P1__',
      '__LOCAL_K7Q2XA_CLS__9',
    ])
      expect(placeholderValueRefusal(p, value), `${p} ${value}`).not.toBeNull()
  })

  it.each(['PaymentGateway', 'chargeCard', '$scope', '_private1', 'x'])(
    'accepts %j under an identifier kind',
    (value) => {
      for (const p of [
        '__CLS__1',
        '__FN__2',
        '__VAR__3',
        '__PKG__4',
        '__STR__5',
        '__CODENAME__1',
        '__P1__',
        '__LOCAL_K7Q2XA_FN__2',
      ])
        expect(placeholderValueRefusal(p, value), `${p} ${value}`).toBeNull()
    }
  )

  it('a manual mark is text the author marked, but never a placeholder or a line break', () => {
    expect(placeholderValueRefusal('__MANUAL__1', 'Jan Kowalski')).toBeNull()
    expect(placeholderValueRefusal('__MANUAL__1', 'Zahlungstür Süd')).toBeNull()
    expect(placeholderValueRefusal('__MANUAL__1', '__FN__1')).not.toBeNull()
    expect(placeholderValueRefusal('__MANUAL__1', 'a\nb')).not.toBeNull()
    expect(placeholderValueRefusal('__MANUAL__1', '   ')).not.toBeNull()
  })

  it('a regulated value is one the scanner finds whole, checksum included', () => {
    expect(placeholderValueRefusal('__IBAN__1', 'GB82 WEST 1234 5698 7654 32')).toBeNull()
    expect(placeholderValueRefusal('__IBAN__1', 'GB82WEST12345698765433')).not.toBeNull()
    expect(placeholderValueRefusal('__IBAN__1', 'x); evil(')).not.toBeNull()
    expect(placeholderValueRefusal('__PESEL__1', '02070803628')).toBeNull()
    expect(placeholderValueRefusal('__PESEL__1', '02070803629')).not.toBeNull()
    expect(placeholderValueRefusal('__PAN__1', '4556737586899855')).toBeNull()
    expect(placeholderValueRefusal('__PAN__1', '4556737586899856')).not.toBeNull()
  })

  it('a kind the engine does not mint a reversible value for is refused', () => {
    expect(placeholderValueRefusal('__REDACTED_AWS__1', 'PaymentGateway')).not.toBeNull()
    expect(placeholderValueRefusal('__LOCAL_K7Q2XA_REDACTED__1', 'PaymentGateway')).not.toBeNull()
    expect(placeholderValueRefusal('not-a-placeholder', 'PaymentGateway')).not.toBeNull()
  })

  it('parseSymbolMap and decryptTeamMap apply it', async () => {
    expect(() => parseSymbolMap({ __FN__1: 'x); evil(' })).toThrow(InvalidMapError)
    const key = await importTeamKey(toBase64(new Uint8Array(32).fill(3)))
    const env = await encryptTeamMap(key, { __FN__1: 'x); evil(' })
    await expect(decryptTeamMap(key, env)).rejects.toThrow(TeamKeyError)
  })

  it('a map the engine made passes, and round-trips through a team envelope and restore', async () => {
    const source =
      `import { Ledger } from 'billing-core'\n` +
      `class PaymentGateway { chargeCard(amountDue) { return "settle ledger" } }\n` +
      `const iban = "GB82 WEST 1234 5698 7654 32"\n// owner: Jan Kowalski\n`
    const r = anonymize(source, { manual: ['Jan Kowalski'] })
    expect(Object.keys(r.map).length).toBeGreaterThan(5)
    expect(parseSymbolMap(r.map)).toEqual(r.map)
    const key = await importTeamKey(toBase64(new Uint8Array(32).fill(4)))
    const opened = await decryptTeamMap(key, await encryptTeamMap(key, r.map))
    expect(opened).toEqual(r.map)
    expect(restore(r.anonymized, opened).restored).toBe(source)
  })
})

describe('a bare placeholder is judged by its kind too', () => {
  it('accepts an identifier under a bare base and refuses operator text', () => {
    expect(placeholderValueRefusal('__LOCAL_ZZ9QQ1_VAR__', 'digitlessGuess')).toBeNull()
    expect(placeholderValueRefusal('__CODENAME__', 'PaymentGateway')).toBeNull()
    expect(placeholderValueRefusal('__CODENAME__', 'x); evil(')).not.toBeNull()
  })
})
