import { describe, it, expect } from 'vitest'
import { anonymize, restore, buildLegend, isPlaceholder } from '../src/index.js'
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
