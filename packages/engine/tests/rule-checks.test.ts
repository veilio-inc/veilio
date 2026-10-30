import { describe, it, expect } from 'vitest'
import {
  isEngineBase,
  isSafeRegex,
  ruleRefusal,
  MANUAL_BASE,
  REDACTION_PREFIX,
  REGULATED_BASES,
  ROLE_BASES,
} from '../src/index.js'

// Spec 065: the server can no longer read a rule, so the checks it made on
// write now live here, where every tool that opens a rule can make them.

describe('isEngineBase', () => {
  it.each([...Object.values(ROLE_BASES), ...Object.values(REGULATED_BASES), MANUAL_BASE])(
    '%s is an engine base',
    (base) => expect(isEngineBase(base as string)).toBe(true)
  )

  it('anything under the redaction prefix is too', () => {
    expect(isEngineBase(`${REDACTION_PREFIX}TOKEN__`)).toBe(true)
  })

  it.each(['__CODENAME__', '__SECRET__', '__PROJECT__'])('%s is not', (p) =>
    expect(isEngineBase(p)).toBe(false)
  )
})

// Moved from the Cloud backend (lib/safe-regex.ts), with one rule added: a
// repeated group holding an alternation - (a|aa)+$ - which its fuzz strings were
// too short to expose and real identifiers are not.
describe('isSafeRegex', () => {
  it.each(['^phoenix$', 'foo', '^[a-z]+_id$', '^(?:alpha|beta)$', 'a{2,5}'])('%s is safe', (p) =>
    expect(isSafeRegex(p)).toBe(true)
  )

  it.each(['(a+)+$', '(\\w+\\s?)*$', '(a|aa)+', '(a|aa)+$', '(?:a|aa)*', '(x+x+)+y', '(', '[a-'])(
    '%s is refused',
    (p) => expect(isSafeRegex(p)).toBe(false)
  )
})

describe('ruleRefusal', () => {
  const replace = {
    name: 'codename',
    type: 'replace' as const,
    pattern: '^phoenix$',
    placeholder: '__CODENAME__',
    enabled: true,
  }
  const whitelist = { name: 'keep', type: 'whitelist' as const, pattern: '^keep$', enabled: true }

  it('accepts a good replace and whitelist rule', () => {
    expect(ruleRefusal(replace)).toBeNull()
    expect(ruleRefusal(whitelist)).toBeNull()
  })

  it.each([
    ['an empty name', { ...replace, name: '' }],
    ['a name of 81 characters', { ...replace, name: 'n'.repeat(81) }],
    ['an empty pattern', { ...replace, pattern: '' }],
    ['a pattern of 501 characters', { ...replace, pattern: 'p'.repeat(501) }],
    ['an unsafe pattern', { ...replace, pattern: '(a+)+$' }],
    ['a placeholder that is not __NAME__', { ...replace, placeholder: 'CODENAME' }],
    ['a lower-case placeholder', { ...replace, placeholder: '__codename__' }],
    ['a reserved __P<n>__', { ...replace, placeholder: '__P3__' }],
    ['an engine base', { ...replace, placeholder: '__FN__' }],
    ['a redaction base', { ...replace, placeholder: `${REDACTION_PREFIX}X__` }],
    ['a replace rule with no placeholder', { ...replace, placeholder: undefined }],
  ])('refuses %s', (_label, rule) => {
    expect(ruleRefusal(rule as never)).toEqual(expect.any(String))
  })

  it('names the engine base in its sentence, as the server did', () => {
    expect(ruleRefusal({ ...replace, placeholder: '__FN__' })).toMatch(
      /reserved for the engine's own names/
    )
  })
})
