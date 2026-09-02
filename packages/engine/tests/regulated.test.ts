import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  SECRET_SEVERITIES,
  detectSecrets,
  ibanValid,
  luhnValid,
  peselValid,
  scanSecrets,
} from '../src/secrets.js'

/**
 * The material the tool is most often reached for, and handled least well.
 *
 * The engine masks identifiers bound by a language's grammar. A regulated value
 * is not one: `const iban = "GB29..."` had its NAME masked and its VALUE passed
 * through untouched, because a string literal is not a symbol.
 *
 * Detection here is structural — arithmetic over the value — never inference.
 * An ML dependency would buy better recall at the cost of the zero-dependency
 * guarantee, which is the whole argument for pasting the output into a model.
 */

const VALID_IBAN = 'GB29NWBK60161331926819'
const VALID_IBAN_SPACED = 'GB29 NWBK 6016 1331 9268 19'
const VALID_PESEL = '44051401359'
const VALID_PAN = '4539578763621486'

describe('checksums', () => {
  it('accepts real IBANs across countries, spaced or not', () => {
    for (const iban of [VALID_IBAN, VALID_IBAN_SPACED, 'DE89370400440532013000', 'PL61109010140000071219812874']) {
      expect(ibanValid(iban), iban).toBe(true)
    }
  })

  it('rejects an IBAN whose check digits do not hold', () => {
    // One digit changed. Length and shape are identical, which is exactly why a
    // regex alone cannot tell these apart.
    expect(ibanValid('GB29NWBK60161331926818')).toBe(false)
  })

  it('computes mod-97 without losing precision on long IBANs', () => {
    // The expanded number exceeds 2^53. Done in one Number() it silently starts
    // accepting invalid IBANs, which is worse than not checking.
    expect(ibanValid('MT84MALT011000012345MTLCAST001S')).toBe(true)
    expect(ibanValid('MT84MALT011000012345MTLCAST001T')).toBe(false)
  })

  it('validates Luhn and PESEL, and rejects near-misses', () => {
    expect(luhnValid(VALID_PAN)).toBe(true)
    expect(luhnValid('1234567890123456')).toBe(false)
    expect(peselValid(VALID_PESEL)).toBe(true)
    expect(peselValid('44051401358')).toBe(false) // check digit off by one
    expect(peselValid('12345678901')).toBe(false)
  })

  it('rejects a PESEL whose checksum passes but whose date cannot exist', () => {
    // Eleven digits is a common enough shape that the check digit alone leaves
    // too many coincidences; the encoded date is the second filter.
    //
    // Every value here is CHECKSUM-VALID — an earlier version of this test used
    // one that failed the checksum too, so it passed while proving nothing and
    // survived the mutation that removes the date check entirely. Month field 99
    // and 13 are impossible; 00 is not a month.
    for (const impossible of ['44991401350', '44131401350', '44001401354']) {
      expect(peselValid(impossible), `${impossible} should be refused on its date`).toBe(false)
    }
  })

  it('accepts the checksum-valid values that differ only in having a real date', () => {
    // The contrast that makes the test above meaningful: same construction, same
    // checksum arithmetic, a month that exists.
    expect(peselValid('44051401359')).toBe(true)
  })
})

describe('detection', () => {
  it('finds a regulated identifier the user never marked', () => {
    expect(detectSecrets(`const iban = "${VALID_IBAN}"`).map((f) => f.type)).toContain('iban')
    expect(detectSecrets(`const pesel = "${VALID_PESEL}"`).map((f) => f.type)).toContain('pesel')
    expect(detectSecrets(`const card = "${VALID_PAN}"`).map((f) => f.type)).toContain('payment-card')
  })

  it('finds an IBAN written with the spacing people actually use', () => {
    expect(detectSecrets(`iban: "${VALID_IBAN_SPACED}"`).map((f) => f.type)).toContain('iban')
  })

  it('says nothing about a look-alike that fails its checksum', () => {
    expect(detectSecrets('const iban = "GB29NWBK60161331926818"')).toEqual([])
    expect(detectSecrets('const id = "12345678901"')).toEqual([])
  })

  it('says nothing about the card numbers every payments fixture contains', () => {
    // Luhn-valid by construction, so the checksum cannot separate them from a
    // real card. Reporting them on every file is the crying-wolf failure the
    // advisory panel exists to remove.
    for (const test of ['4111111111111111', '4242424242424242', '5555555555554444', '378282246310005']) {
      expect(detectSecrets(`const card = "${test}"`), test).toEqual([])
    }
  })

  it('truncates the preview, as every other finding does', () => {
    // A finding carrying the whole value re-creates the leak it warns about —
    // findings are rendered and reach logs.
    const [finding] = detectSecrets(`const iban = "${VALID_IBAN}"`)
    expect(finding.preview).not.toContain(VALID_IBAN)
    expect(finding.preview.length).toBeLessThan(VALID_IBAN.length)
  })
})

describe('policy', () => {
  it('redacts under redact, and the value does not survive', () => {
    const scan = scanSecrets(`const iban = "${VALID_IBAN}"`, 'redact')
    expect(scan.findings[0].redacted).toBe(true)
    expect(scan.code).not.toContain(VALID_IBAN)
    expect(scan.code).toContain('__REDACTED_IBAN_1__')
  })

  it('reports and leaves in place under warn', () => {
    const scan = scanSecrets(`const iban = "${VALID_IBAN}"`, 'warn')
    expect(scan.findings.length).toBe(1)
    expect(scan.findings[0].redacted).toBe(false)
    expect(scan.code).toContain(VALID_IBAN)
  })

  it('reports nothing under off', () => {
    expect(scanSecrets(`const iban = "${VALID_IBAN}"`, 'off').findings).toEqual([])
  })
})

describe('grading agrees with the advisory panel work', () => {
  it('grades a checksum-plus-format match above a bare checksum', () => {
    // mod-97 over a country-prefixed structure is far stronger evidence than a
    // Luhn-valid digit run, and the grades have to say so or the scale stops
    // carrying information again.
    expect(SECRET_SEVERITIES.iban).toBe('high')
    expect(SECRET_SEVERITIES['payment-card']).toBe('medium')
    expect(SECRET_SEVERITIES.pesel).toBe('medium')
  })
})

describe('no false positives on ordinary source', () => {
  it('finds no regulated identifier anywhere in this package', () => {
    // SC-003, run against real code rather than a curated fixture: version
    // numbers, timestamps, hashes, ports, and long numeric constants are what
    // actually surrounds a digit run in practice.
    const dir = new URL('../src/', import.meta.url).pathname
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(3)

    const offenders: string[] = []
    for (const file of files) {
      // secrets.ts contains the test-PAN list and example IBANs by necessity.
      if (file === 'secrets.ts') continue
      for (const f of detectSecrets(readFileSync(join(dir, file), 'utf8'))) {
        if (f.type === 'iban' || f.type === 'payment-card' || f.type === 'pesel') {
          offenders.push(`${file}:${f.line} ${f.type}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('ignores the numeric shapes source code is full of', () => {
    const ordinary = [
      'const ts = 1735689600000',
      'const version = "20260902120000"',
      'const port = 8080',
      'const sha = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3"',
      'const big = 123456789012345',
      'const phone = "+48 123 456 789"',
    ]
    for (const line of ordinary) {
      const found = detectSecrets(line).filter(
        (f) => f.type === 'iban' || f.type === 'payment-card' || f.type === 'pesel'
      )
      expect(found.map((f) => f.type), line).toEqual([])
    }
  })
})
