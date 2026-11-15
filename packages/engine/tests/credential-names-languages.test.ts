import { describe, it, expect } from 'vitest'
import { anonymize } from '../src/index.js'
import type { AnonymizeOptions } from '../src/types.js'
import {
  LOCAL_NAMES,
  LOCAL_VALUE,
  ORDINARY_NAMES,
  PINNED_NAMES,
  SENTENCE,
} from './fixtures/baseline-corpus.js'
import { expectKept, expectRedacted } from './fixtures/credential-checks.js'

// A password is a password in the developer's own language. A value assigned
// to a name that is, or ends in, one of these words is redacted one-way, as
// under an English credential name: the words for a password and a secret in
// Polish, German, Spanish, French, Portuguese, Dutch and Greek, in the
// spelling with and without diacritics, and the word for a key only together
// with "api". The name itself is treated as before.

const KINDS: [kind: string, text: (name: string) => string, options: AnonymizeOptions][] = [
  ['TypeScript', (name) => `const ${name} = "${LOCAL_VALUE}"\n`, { language: 'typescript' }],
  ['Python', (name) => `${name} = "${LOCAL_VALUE}"\n`, { language: 'python' }],
  ['YAML', (name) => `${name}: ${LOCAL_VALUE}\nport: 8080\n`, { fileKind: 'yaml' }],
  ['YAML, quoted', (name) => `${name}: "${LOCAL_VALUE}"\n`, { fileKind: 'yaml' }],
  ['an env file', (name) => `${name}=${LOCAL_VALUE}\n`, { fileKind: 'dotenv' }],
]
const capital = (name: string): string => name[0]!.toUpperCase() + name.slice(1)
const SPELLINGS: [spelling: string, as: (name: string) => string][] = [
  ['as written', (name) => name],
  ['after a prefix', (name) => `db_${name}`],
  ['ending a camel-case name', (name) => `db${capital(name)}`],
  ['in capitals', (name) => name.toUpperCase()],
  ['in capitals after a prefix', (name) => `DB_${name.toUpperCase()}`],
]

describe.each(LOCAL_NAMES)('a value under the name %s', (name) => {
  describe.each(KINDS)('in %s', (_, text, options) => {
    it.each(SPELLINGS)('%s', (_, as) => {
      expectRedacted(text(as(name)), options, [LOCAL_VALUE])
    })
  })
})

it('Greek capitals written without the accent', () => {
  for (const name of ['ΚΩΔΙΚΟΣ', 'ΣΥΝΘΗΜΑΤΙΚΟ'])
    expectRedacted(`${name}=${LOCAL_VALUE}\n`, { fileKind: 'dotenv' }, [LOCAL_VALUE])
})

it('a quoted key and a pair inside a value', () => {
  expectRedacted(`const o = { "hasło": "${LOCAL_VALUE}" }\n`, { language: 'typescript' }, [
    LOCAL_VALUE,
  ])
  expectRedacted(`const dsn = "Server=db;Kennwort=${LOCAL_VALUE};"\n`, { language: 'typescript' }, [
    LOCAL_VALUE,
  ])
})

describe('the value is read as under a name 1.19.2 already knew', () => {
  // `passwort` holds an English credential word, so its value was redacted
  // before: every value is treated the same under a name of the list.
  const VALUES = [LOCAL_VALUE, 'zielonapapuga', 'Zielona Papuga 2026', 'abc12', 'true', '${DB_PW}']
  it.each(VALUES)('%s', (value) => {
    for (const [, text, options] of KINDS) {
      const under = (name: string): string =>
        anonymize(text(name).replace(LOCAL_VALUE, value), options).anonymized
      expect(under('kennwort')).toBe(under('passwort'))
    }
  })
})

describe('names 1.19.2 read already', () => {
  it.each(PINNED_NAMES)('%s', (name) => {
    for (const [, text, options] of KINDS) expectRedacted(text(name), options, [LOCAL_VALUE])
  })
})

describe('a name that only looks like one is read as before', () => {
  // A longer word that starts with one, a word inside another, and the bare
  // words for "key", "word" and "hidden": ordinary names, never redacted.
  it.each(ORDINARY_NAMES)('%s', (name) => {
    expectKept(`const ${name} = "${SENTENCE}"\n`, { language: 'typescript' })
    const { anonymized } = anonymize(`const ${name} = "${LOCAL_VALUE}"\n`, {
      language: 'typescript',
    })
    expect(anonymized).not.toContain('__REDACTED_')
  })
})

// The Greek word is also the word for any code (a postal code, a product
// code): it names a password alone or after a qualifier of a credential
// (`db_`, `user_`, `api_`), never after another word.
describe('κωδικός after another word is a code, not a password', () => {
  it.each([
    'ταχυδρομικός_κωδικός',
    'taxydromikos_kodikos',
    'productKodikos',
    'ΤΑΧΥΔΡΟΜΙΚΟΣ_ΚΩΔΙΚΟΣ',
  ])('%s', (name) => {
    const { anonymized } = anonymize(`const ${name} = "${LOCAL_VALUE}"\n`, {
      language: 'typescript',
    })
    expect(anonymized).not.toContain('__REDACTED_')
    const env = anonymize(`${name}=${LOCAL_VALUE}\n`, { fileKind: 'dotenv' })
    expect(env.anonymized).not.toContain('__REDACTED_')
  })

  it.each(['user_κωδικός', 'adminKodikos', 'SMTP_ΚΩΔΙΚΟΣ', 'api-kodikos'])('%s is one', (name) => {
    expectRedacted(`${name}: ${LOCAL_VALUE}\nport: 8080\n`, { fileKind: 'yaml' }, [LOCAL_VALUE])
  })
})
