import { describe, it, expect } from 'vitest'
import { anonymize } from '../src/index.js'
import type { AnonymizeOptions } from '../src/types.js'
import { COMMIT_ID, OPAQUE, PROVIDER_KEYS, UNLISTED_KEYS } from './fixtures/baseline-corpus.js'
import { expectKept, expectRedacted } from './fixtures/credential-checks.js'

// A key in a provider's own format is a credential wherever it stands,
// whatever its variable is called: redacted one-way, never written to the
// map. Each format is the one the vendor documents (the source is beside its
// rule in src/secrets.ts); the keys here are made up and built at run time.

const TS: AnonymizeOptions = { language: 'typescript' }
const SHELL: AnonymizeOptions = { fileKind: 'shell' }

const PLACES: [place: string, text: (key: string) => string, options: AnonymizeOptions][] = [
  ['assigned to a neutral name', (key) => `const note = "${key}"\n`, TS],
  ['as a call argument', (key) => `send("${key}")\n`, TS],
  ['as a word of a shell command', (key) => `echo ${key}\n`, SHELL],
  ['in a comment', (key) => `const n = 1 // was ${key}\n`, TS],
  ['in a URL', (key) => `const url = "https://x.example/hook?t=${key}&v=2"\n`, TS],
]

describe.each(PROVIDER_KEYS)('$provider', ({ key, short }) => {
  it.each(PLACES)('is redacted %s', (_, text, options) => {
    expectRedacted(text(key), options, [key])
  })

  it('gives the same on a second pass over the first pass’s map', () => {
    const code = `const note = "${key}"\nconst customerTotal = 1\n`
    const first = anonymize(code, TS)
    const second = anonymize(code, { ...TS, existingMap: first.map })
    expect(second.anonymized).toBe(first.anonymized)
    expect(second.map).toEqual(first.map)
  })

  it('is redacted where an older map already holds it', () => {
    const { anonymized, map } = anonymize(`const note = "${key}"\n`, {
      ...TS,
      existingMap: { __STR__1: key },
    })
    expect(anonymized).toContain('__REDACTED_')
    expect(Object.values(map)).not.toContain(key)
  })

  it('one character short of the format is not redacted', () => {
    expectKept(`const note = "${short}"\n`, TS)
  })
})

describe('an ordinary name that starts like a key is read as before', () => {
  // A prefix alone is no key: a body of words, with no digit, is a name.
  it.each([
    'xapp-production-api-gateway',
    'xwfp-workflow-publisher-name',
    'github_pat_placeholder_for_the_documentation_examples',
  ])('%s', (name) => {
    expectKept(`const note = "${name}"\n`, TS)
    expectKept(`echo ${name}\n`, SHELL)
  })
})

describe('a format no vendor document states is read as before', () => {
  it.each(UNLISTED_KEYS)('$provider', ({ key }) => {
    expect(anonymize(`const note = "${key}"\n`, TS).anonymized).not.toContain('__REDACTED_')
  })
})

// A token of no listed format is a credential when the text beside it says
// so: a credential word on its line, outside the value, or a password flag
// before it. With no such word it is read as before - a hash, an identifier
// and a commit id have the same shape, and a redaction cannot be undone.
describe('a high-entropy value beside a credential word', () => {
  it.each<[string, string, AnonymizeOptions]>([
    ['a credential word after the value', `send("${OPAQUE}", { token: true })\n`, TS],
    ['a credential word in another argument', `log("api key", "${OPAQUE}")\n`, TS],
    ['a credential word in a comment', `const note = "${OPAQUE}" // the API key\n`, TS],
    ['a credential word in a camel-case name', `use("${OPAQUE}", authToken)\n`, TS],
    [
      'after -p on a command the engine has no list for',
      `acmectl sync -p ${OPAQUE} --all\n`,
      SHELL,
    ],
    ['after -p, quoted', `acmectl sync -p "${OPAQUE}" --all\n`, SHELL],
  ])('is redacted: %s', (_, code, options) => {
    expectRedacted(code, options, [OPAQUE])
  })

  it.each<[string, string, AnonymizeOptions]>([
    ['no credential word', `const note = "${OPAQUE}"\n`, TS],
    ['the word only inside the value', `const note = "token_${OPAQUE}"\n`, TS],
    ['a word that only starts like one', `const author = pick("${COMMIT_ID}")\n`, TS],
    ['a word that only holds one', `tokenizer.feed("${OPAQUE}", keyboard)\n`, TS],
    ['the word on another line', `// the API key\nconst note = "${OPAQUE}"\n`, TS],
    ['a port after -p', 'acmectl sync -p 8080 --all\n', SHELL],
    [
      'a route beside a credential',
      "request('/api/auth/keys/personal-maps', { credential })\n",
      TS,
    ],
    ['a versioned route', "request('/api/v2/auth/keys/personal-maps', { credential })\n", TS],
    ['a compound name', 'use("base64UrlEncodeSha256Digest", authToken)\n', TS],
    ['a dated slug', 'use("feature-flag-2026-rollout-auth", authToken)\n', TS],
  ])('is read as before: %s', (_, code, options) => {
    expectKept(code, options)
  })

  it('a value of lower-case letters only stays masked, not readable', () => {
    const word = 'abcdefghijklmnopqrstuvwxyzabcd'
    const { anonymized, map } = anonymize(`send("${word}", { token: true })\n`, TS)
    expect(anonymized).not.toContain(word)
    expect(Object.values(map)).toContain(word)
  })
})
