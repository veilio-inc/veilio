import { describe, it, expect } from 'vitest'
import { anonymize, isOrdinaryWord, restore } from '../src/index.js'

// Spec 064: an identifier that is a single common English word, a toolchain's
// name or a path segment every project has stays as written. In spec 062's
// sessions 57% of placeholders hid such a word (java, ledger, com, recent), and
// the model then listed the whole tree to find files it could not read.
// Distinctive names stay masked.

describe('isOrdinaryWord', () => {
  it.each(['ledger', 'Ledger', 'LEDGER', 'recent', 'planner', 'invoice', 'total', 'seed', 'runs'])(
    '%s is ordinary',
    (w) => expect(isOrdinaryWord(w)).toBe(true)
  )

  it.each([
    'java',
    'com',
    'org',
    'src',
    'util',
    'vitest',
    'unittest',
    'junit',
    'pytest',
    'mvn',
    'npx',
  ])('%s (programming vocabulary or a toolchain) is ordinary', (w) =>
    expect(isOrdinaryWord(w)).toBe(true)
  )

  it.each([
    ['ledgerEntry', 'an inner capital'],
    ['berth_quorum', 'an underscore'],
    ['SkerryTariff', 'two words'],
    ['invoice2', 'a digit'],
    ['tarnwick', 'an invented word'],
    ['quayward', 'an invented word'],
    ['skerry', 'a rare word that identifies more than it describes'],
    ['lEdger', 'a mixed case no word has'],
  ])('%s is not (%s)', (w) => expect(isOrdinaryWord(w)).toBe(false))
})

const SRC = [
  'export class Ledger {',
  '  recent: number = 0',
  '  quaywardThrottle(total: number) { return total + this.recent }',
  '}',
  'export const tarnwick = new Ledger()',
].join('\n')

describe('masking leaves ordinary words and masks the rest', () => {
  it('keeps ordinary words as written', () => {
    const { anonymized, map } = anonymize(SRC, { language: 'typescript' })
    for (const w of ['Ledger', 'recent', 'total']) {
      expect(anonymized).toMatch(new RegExp(`\\b${w}\\b`))
      expect(Object.values(map)).not.toContain(w)
    }
    for (const w of ['quaywardThrottle', 'tarnwick']) {
      expect(anonymized).not.toMatch(new RegExp(`\\b${w}\\b`))
      expect(Object.values(map)).toContain(w)
    }
  })

  it('an ordinary word an older map holds is no longer emitted, and its entry still restores old text', () => {
    const older = { __VAR__7: 'recent', __FN__2: 'quaywardThrottle' }
    const { anonymized, map } = anonymize(SRC, { language: 'typescript', existingMap: older })
    expect(anonymized).not.toContain('__VAR__7')
    expect(anonymized).toMatch(/\brecent\b/)
    expect(map.__VAR__7).toBe('recent')
    expect(restore('return __VAR__7', map).restored).toBe('return recent')
  })

  it('a custom replace rule still masks an ordinary word', () => {
    const { anonymized } = anonymize(SRC, {
      language: 'typescript',
      rules: [
        {
          id: 'r1',
          scope: 'personal',
          team_id: null,
          name: 'always mask recent',
          type: 'replace',
          pattern: '^recent$',
          placeholder: '__SECRET__',
          enabled: true,
          sort_order: 0,
        },
      ],
    })
    expect(anonymized).not.toMatch(/\brecent\b/)
    expect(anonymized).toContain('__SECRET__1')
  })
})

describe('inside a credential, an older map still masks an ordinary word (security review)', () => {
  it('client_secret: "disabled" keeps its placeholder; the same word elsewhere is readable', () => {
    const code = 'client_secret: "disabled"\nconst mode = disabled\n'
    const { anonymized } = anonymize(code, {
      language: 'typescript',
      existingMap: { __VAR__9: 'disabled' },
    })
    expect(anonymized).toContain(': "__VAR__9"')
    expect(anonymized).toContain('const mode = disabled')
  })
})

describe('a rule made after a word was masked by the engine (code review)', () => {
  it('gives the word a rule placeholder too, so a masking that keeps rule entries still hides it', () => {
    const { anonymized, map } = anonymize('deploy(phoenix)\n', {
      language: 'typescript',
      existingMap: { __VAR__3: 'phoenix' },
      rules: [
        {
          id: 'r1',
          scope: 'team',
          team_id: 't',
          name: 'codename',
          type: 'replace',
          pattern: '^phoenix$',
          placeholder: '__CODENAME__',
          enabled: true,
          sort_order: 0,
        },
      ],
    })
    expect(anonymized).not.toMatch(/\bphoenix\b/)
    expect(anonymized).toContain('__CODENAME__1')
    expect(map.__CODENAME__1).toBe('phoenix')
    // The old placeholder still restores old text.
    expect(map.__VAR__3).toBe('phoenix')
  })
})
