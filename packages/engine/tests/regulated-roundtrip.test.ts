import { describe, it, expect } from 'vitest'
import {
  anonymize,
  restore,
  buildLegend,
  isPlaceholder,
  detectSecrets,
  hasBlockingSecrets,
} from '../src/index.js'
import {
  VALID_IBAN,
  VALID_IBAN_2,
  VALID_PESEL,
  VALID_PAN,
  CREDENTIAL,
} from './fixtures/regulated.js'

/**
 * Spec 009 — regulated identifiers round-trip.
 *
 * This reverses spec 003 US2, which decided regulated identifiers were
 * destroyed like credentials. The argument for the reversal is that the two are
 * not alike:
 *
 *   A credential is issued by a service and the response to exposure is to
 *   rotate it, so destroying it costs nothing. A person cannot reissue their
 *   PESEL, and a developer debugging a payments bug needs their IBAN back —
 *   destroying it returns code that no longer runs.
 *
 * What must NOT follow from that is credentials becoming recoverable. That
 * guarantee is asserted in secrets.test.ts and is mutation-checked; if it ever
 * goes soft, this feature has reintroduced the exact defect `secrets.ts` was
 * written to prevent.
 */

const SOURCE = `
const acct = "${VALID_IBAN}"
const pan = "${VALID_PAN}"
const pesel = "${VALID_PESEL}"
`.trim()

describe('a regulated identifier survives the round trip', () => {
  it('masks all three formats and restores byte-identically (V1)', () => {
    const result = anonymize(SOURCE, {})

    for (const value of [VALID_IBAN, VALID_PAN, VALID_PESEL]) {
      expect(result.anonymized, `${value} reached the output`).not.toContain(value)
    }
    expect(result.map['__IBAN__1']).toBe(VALID_IBAN)
    expect(result.map['__PAN__1']).toBe(VALID_PAN)
    expect(result.map['__PESEL__1']).toBe(VALID_PESEL)

    // The point of the whole feature: the code the developer gets back runs.
    expect(restore(result.anonymized, result.map).restored).toBe(SOURCE)
  })

  it('gives one placeholder to a value that appears several times (V4)', () => {
    // A behaviour change, not only a new assertion. `scanSecrets` incremented
    // its counter per MATCH, so three copies produced three tokens — harmless
    // while the value was destroyed, a defect once it round-trips, because the
    // map would then hold the same identifier three times under three keys.
    const repeated = [
      `const a = "${VALID_IBAN}"`,
      `const b = "${VALID_IBAN}"`,
      `const c = "${VALID_IBAN}"`,
    ].join('\n')

    const result = anonymize(repeated, {})
    const ibanKeys = Object.keys(result.map).filter((k) => k.startsWith('__IBAN__'))

    expect(ibanKeys).toEqual(['__IBAN__1'])
    expect(restore(result.anonymized, result.map).restored).toBe(repeated)
  })

  it('still distinguishes two different values', () => {
    // The control for the case above: deduping by value must not collapse two
    // genuinely different accounts into one placeholder, which would restore
    // the wrong number into one of them.
    const two = `const a = "${VALID_IBAN}"\nconst b = "${VALID_IBAN_2}"`
    const result = anonymize(two, {})

    expect(result.map['__IBAN__1']).toBe(VALID_IBAN)
    expect(result.map['__IBAN__2']).toBe(VALID_IBAN_2)
    expect(restore(result.anonymized, result.map).restored).toBe(two)
  })

  it('reuses a placeholder already in the existing map', () => {
    // Without this a second pass over the same file grows the map every time.
    const first = anonymize(SOURCE, {})
    const second = anonymize(SOURCE, { existingMap: first.map })

    expect(Object.keys(second.map).filter((k) => k.startsWith('__IBAN__'))).toEqual(['__IBAN__1'])
    expect(second.map['__IBAN__1']).toBe(VALID_IBAN)
  })

  it('mints placeholders the extractor will not re-mask (V-FR006)', () => {
    // PLACEHOLDER_TOKEN already matches these shapes, so the guard that keeps
    // redaction tokens out of identifier extraction covers them unchanged.
    // Confirmed rather than assumed: that same regex backs `isPlaceholder`,
    // which is also what stops a map carrying a prototype-pollution key.
    for (const token of ['__IBAN__1', '__PAN__1', '__PESEL__1']) {
      expect(isPlaceholder(token), token).toBe(true)
    }

    // And end-to-end: re-anonymising the output does not mask its own tokens.
    const first = anonymize(SOURCE, {})
    const again = anonymize(first.anonymized, { existingMap: first.map })
    expect(again.anonymized).toContain('__IBAN__1')
    expect(again.anonymized).not.toContain('____')
  })
})

describe('policies that promise not to touch the code keep the promise (V8)', () => {
  it('writes no map entry under warn', () => {
    const result = anonymize(SOURCE, { secrets: 'warn' })

    expect(result.anonymized).toContain(VALID_IBAN)
    expect(result.secrets.length).toBeGreaterThan(0)
    expect(Object.keys(result.map).filter((k) => k.startsWith('__IBAN__'))).toEqual([])
  })

  it('detects nothing at all under off', () => {
    const result = anonymize(SOURCE, { secrets: 'off' })

    expect(result.secrets).toEqual([])
    expect(Object.keys(result.map).filter((k) => k.startsWith('__PAN__'))).toEqual([])
  })
})

describe('a value marked by hand keeps its own placeholder (V6, D3)', () => {
  it('lets the manual mark win, and mints only one placeholder', () => {
    const result = anonymize(SOURCE, { manual: [VALID_IBAN] })

    const forValue = Object.entries(result.map).filter(([, v]) => v === VALID_IBAN)
    expect(forValue.length, 'the value was masked twice').toBe(1)
    expect(forValue[0][0]).toMatch(/^__MANUAL__\d+$/)
    expect(Object.keys(result.map).filter((k) => k.startsWith('__IBAN__'))).toEqual([])

    expect(restore(result.anonymized, result.map).restored).toBe(SOURCE)
  })
})

describe('the legend says what was taken out, without saying what it was (V9)', () => {
  it('names each regulated class and reproduces no value', () => {
    const result = anonymize(SOURCE, {})
    const legend = buildLegend(result.map)

    expect(legend).toMatch(/bank account numbers/i)
    expect(legend).toMatch(/payment card numbers/i)
    expect(legend).toMatch(/national identification numbers/i)

    for (const value of [VALID_IBAN, VALID_PAN, VALID_PESEL]) {
      expect(legend, 'the legend leaked a value').not.toContain(value)
    }
  })
})

describe('output from an older engine still restores (V7)', () => {
  it('leaves a redaction token from 1.5.0 alone', () => {
    // A 1.5.0 map carries no regulated entries and its output carries
    // __REDACTED_IBAN_1__ tokens. Nothing in this feature changes the map
    // format — it is a flat Record<string,string> and always was — so
    // compatibility holds by construction.
    //
    // It still gets a test, because "holds by construction" is exactly how the
    // zero-knowledge claim was described during the eleven weeks it was false.
    const legacyOutput = 'const acct = "__REDACTED_IBAN_1__"\nconst name = "__STR__1"'
    const legacyMap = { __STR__1: 'Kowalski' }

    const { restored } = restore(legacyOutput, legacyMap)

    expect(restored).toContain('__REDACTED_IBAN_1__')
    expect(restored).toContain('Kowalski')
  })
})

describe('the credential in the same file is not swept along', () => {
  it('destroys the credential while masking the identifiers', () => {
    // The two dispositions meeting in one input is the case most likely to go
    // wrong, and the one a happy-path test would never reach.
    const mixed = `${SOURCE}\nconst key = "${CREDENTIAL}"`
    const result = anonymize(mixed, {})

    expect(result.anonymized).not.toContain(CREDENTIAL)
    expect(Object.values(result.map), 'the credential reached the map').not.toContain(CREDENTIAL)
    expect(result.map['__IBAN__1']).toBe(VALID_IBAN)

    const { restored } = restore(result.anonymized, result.map)
    expect(restored).toContain(VALID_IBAN)
    expect(restored, 'the credential came back').not.toContain(CREDENTIAL)
  })
})

describe('a value any rule reads as a credential is never masked reversibly', () => {
  /**
   * The overlap rule ranked the IBAN / card / PESEL detectors above the
   * generic credential matchers (password-assignment, connection-string,
   * bearer-token...). Harmless while regulated values were destroyed too. Once
   * they became reversible (spec 009), a credential that happened to pass a
   * checksum lost the overlap and was written into the SymbolMap instead of
   * destroyed - and stopped blocking the paste. Found by security review.
   *
   * Rule now: when a credential match and a regulated match overlap, the value
   * is destroyed. Including when the credential verdict is only AMBIGUOUS -
   * "might be a live credential" is exactly what must never reach the map.
   */
  const cases: Array<[string, string, string]> = [
    ['a card-shaped password', `password = "${VALID_PAN}"`, VALID_PAN],
    ['a card-shaped value under a secret-looking name', `const secret = "${VALID_PAN}"`, VALID_PAN],
    [
      'a card-shaped run inside a connection-string password',
      `const url = "postgres://admin:Zx9-${VALID_PAN}-Qw@db.internal:5432/app"`,
      VALID_PAN,
    ],
    [
      'a card-shaped segment inside a bearer token',
      `const h = "Authorization: Bearer abcDEF.${VALID_PAN}.xyzQWE123"`,
      VALID_PAN,
    ],
  ]

  it.each(cases)('destroys %s, keeps it out of the map, and blocks', (_name, src, value) => {
    const r = anonymize(src, {})
    expect(Object.values(r.map), 'the credential reached the SymbolMap').not.toContain(value)
    expect(r.anonymized).not.toContain(value)
    expect(hasBlockingSecrets(r.secrets)).toBe(true)
    expect(restore(r.anonymized, r.map).restored, 'restore brought it back').not.toContain(value)
  })

  it('destroys a PESEL-shaped API key - an AMBIGUOUS verdict, so it does not block', () => {
    // 44051401359 has entropy 2.48, just under the 2.6 floor, so after
    // `api_key =` it is read as MAYBE a credential. It is destroyed rather than
    // masked (the point of this block), and - like every ambiguous verdict - it
    // is reported rather than blocking. The confident cases above do block.
    const r = anonymize(`const api_key = "${VALID_PESEL}"`, {})
    expect(Object.values(r.map)).not.toContain(VALID_PESEL)
    expect(r.anonymized).not.toContain(VALID_PESEL)
    expect(r.secrets.find((f) => f.type === 'pesel')?.disposition).toBe('destroy')
    expect(hasBlockingSecrets(r.secrets)).toBe(false)
  })

  it('destroys a checksum-valid number whose credential verdict is only ambiguous', () => {
    // 4444444444444448 passes Luhn with a Visa prefix, but its entropy (0.34)
    // is under the floor, so after `password =` it is read as MAYBE a
    // credential. Masking it would persist a possible live secret; reporting it
    // would send it to the model verbatim. Destroying it is the only answer
    // that does neither.
    const LOW_ENTROPY_PAN = '4444444444444448'
    expect(
      detectSecrets(`const n = "${LOW_ENTROPY_PAN}"`).some((f) => f.type === 'payment-card')
    ).toBe(true)
    const r = anonymize(`password = "${LOW_ENTROPY_PAN}"`, {})
    expect(Object.values(r.map)).not.toContain(LOW_ENTROPY_PAN)
    expect(r.anonymized).not.toContain(LOW_ENTROPY_PAN)
    expect(r.secrets.every((f) => f.redacted === (f.disposition === 'destroy'))).toBe(true)
  })

  it('CONTROL: still masks a regulated value with no credential around it', () => {
    // Without this, every case above passes just as well if regulated
    // identifiers had simply gone back to being destroyed everywhere.
    const r = anonymize(`const acct = "${VALID_IBAN}"`, {})
    expect(r.map['__IBAN__1']).toBe(VALID_IBAN)
    expect(hasBlockingSecrets(r.secrets)).toBe(false)
  })
})
