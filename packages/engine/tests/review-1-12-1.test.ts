import { describe, expect, it } from 'vitest'
import { anonymize, restore } from '../src/index.js'

// The nine reproductions from the code review of #172, each a test.
const mapped = (r: { map: Record<string, string> }) => Object.values(r.map)

describe('1.12.1 review', () => {
  it('1: a name equal to a reported-only weak value is never mapped', () => {
    const r = anonymize('password = "sunshine"\nfunction sunshine() {}', { path: 'a.js' })
    expect(mapped(r)).not.toContain('sunshine')
  })

  it('2: a name holding a credential is redacted whole and restores without a token inside a name', () => {
    const r = anonymize('PGPASSWORD=Kx9_prodpw\nfunction Kx9_prodpwHelper() {}\nKx9_prodpwHelper()')
    expect(r.anonymized).not.toContain('Kx9_prodpw')
    expect(mapped(r).join('|')).not.toMatch(/Kx9_prodpw|__REDACTED_/)
    expect(restore(r.anonymized, r.map).restored).not.toMatch(/__REDACTED_[A-Z_]+_\d+__[A-Za-z]/)
  })

  it('3: a manual term inside a credential never leaves part of it', () => {
    const r = anonymize('PGPASSWORD=acmeCorp_2024!\nconst url = "acmeCorp_2024!"', {
      manual: ['acmeCorp'],
    })
    expect(r.anonymized).not.toMatch(/_2024/)
    expect(mapped(r).join('|')).not.toMatch(/2024/)
  })

  it('4: a destroyed credential that also looks like a PESEL is not mapped', () => {
    const r = anonymize('PGPASSWORD=44051401359\nconst id = "44051401359"', { path: 'a.js' })
    expect(mapped(r)).not.toContain('44051401359')
    expect(r.anonymized).not.toContain('44051401359')
  })

  it('5: a manual term equal to a credential found in the text is refused', () => {
    expect(() =>
      anonymize('PGPASSWORD=Kx9_prodpw\nconst s = "Kx9_prodpw"', { manual: ['Kx9_prodpw'] })
    ).toThrow()
  })

  it('6: an argv array written one element per line is caught', () => {
    const r = anonymize('subprocess.run([\n  "redis-cli",\n  "-a",\n  "Zq8vLm2xT",\n])', {
      path: 'a.py',
    })
    expect(r.anonymized).not.toContain('Zq8vLm2xT')
    expect(mapped(r)).not.toContain('Zq8vLm2xT')
  })

  it('7: --password=KEY in a source file is redacted', () => {
    const r = anonymize('tool --password=KEY\n', { path: 'deploy.sh' })
    expect(r.anonymized).not.toMatch(/=KEY\b/)
  })

  it('8: an unclosed ${ inside a password does not cut it', () => {
    const r = anonymize('PGPASSWORD=Kx9vQ2${q7Lm psql\n', { path: 'run.sh' })
    expect(mapped(r).join('|')).not.toMatch(/Kx9vQ2|q7Lm/)
  })

  it('9: a redaction token in the text is never split', () => {
    const r = anonymize('PGPASSWORD=EDACTED_C\n')
    expect(r.anonymized).toBe('PGPASSWORD=__REDACTED_CREDENTIAL_1__\n')
  })

  it('9b: a placeholder from an earlier output is never split by a credential inside it', () => {
    const r = anonymize('PGPASSWORD=2024 psql\nconst x = __VAR__12024\n', {
      existingMap: { __VAR__12024: 'orderTotal' },
    })
    expect(r.anonymized).toContain('__VAR__12024')
  })

  it('9c: a name that only looks like a placeholder is redacted whole when it holds a credential', () => {
    const r = anonymize('PGPASSWORD=2024 psql\nconst x = __VAR__12024\n')
    expect(r.anonymized).not.toContain('2024')
  })

  it('4b: a PESEL that is also a credential left in place is neither shown nor mapped', () => {
    const r = anonymize('PGPASSWORD=44051401359\nconst id = "44051401359"', {
      path: 'tests/a.test.js',
    })
    expect(r.anonymized).not.toContain('44051401359')
    expect(Object.values(r.map)).not.toContain('44051401359')
  })

  it('9d: a token-shaped name the call did not mint is not trusted', () => {
    const r = anonymize('PGPASSWORD=KXQPRODPWZ psql\nconst x = __REDACTED_KXQPRODPWZ_7__\n')
    expect(r.anonymized).not.toContain('KXQPRODPWZ')
  })

  it('6b: a mysql -pSECRET argv element after other arguments is still caught (1.12.0 behaviour)', () => {
    const r = anonymize('execFile("mysql", ["-u", user, "-pZq8vLm2xT"])', { path: 'a.js' })
    expect(r.anonymized).not.toContain('Zq8vLm2xT')
    expect(Object.values(r.map).join('|')).not.toContain('Zq8vLm2xT')
  })

  it('5b: a manual mark replayed from the map, or on a possible credential, still masks', () => {
    const code = 'const auth = { client_secret: "disabled" }\nconst x = "disabled"'
    expect(() => anonymize(code, { existingMap: { __MANUAL__1: 'disabled' } })).not.toThrow()
    expect(() =>
      anonymize('const x = "acmeCorp9x"', { manual: ['acmeCorp9x'], secrets: 'off' })
    ).not.toThrow()
  })

  it('5c: a credential left in place by warn, off or a fixture cannot be marked into the map', () => {
    for (const opts of [
      { secrets: 'warn' as const },
      { secrets: 'off' as const },
      { path: 'tests/a.test.js' },
    ]) {
      expect(() =>
        anonymize('PGPASSWORD=Summer24 psql\nconst s = "Summer24"', {
          ...opts,
          manual: ['Summer24'],
        })
      ).toThrow()
    }
  })

  it('4c: a forced-destroyed regulated value is not left in the map', () => {
    const r = anonymize('const c = { secret: "44051401359" }\nconst id = "44051401359"', {
      path: 'a.js',
    })
    expect(Object.values(r.map)).not.toContain('44051401359')
  })

  it('2b: a credential starting with punctuation does not swallow the name before it', () => {
    const r = anonymize('PGPASSWORD="!Zq8vLm2xTq" psql\nconst s = "foo!Zq8vLm2xTq"\n')
    expect(r.anonymized).not.toContain('Zq8vLm2xTq')
    expect(Object.values(r.map).join('|') + r.anonymized).toMatch(/foo/)
  })
})
