import { describe, it, expect } from 'vitest'
import { anonymize } from '../src/index.js'
import type { AnonymizeOptions } from '../src/types.js'
import { PROVIDER_KEYS, UNLISTED_KEYS } from './fixtures/baseline-corpus.js'
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
