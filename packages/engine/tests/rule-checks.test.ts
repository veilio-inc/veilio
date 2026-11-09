import { describe, it, expect } from 'vitest'
import {
  isEngineBase,
  isSafeRegex,
  ruleRefusal,
  MANUAL_BASE,
  REDACTION_PREFIX,
  REGULATED_BASES,
  ROLE_BASES,
  encryptTeamMap,
  importTeamKey,
  openTeamRule,
  sealTeamRule,
  toBase64,
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

  // Spec 066: a rule under the local family would mint names a teammate leaves
  // unrestored, and a publish would renumber them as the engine's.
  it.each(['__LOCAL_X__', '__LOCAL_K7Q2XA_VAR__', '__LOCAL_K7Q2XA_CODENAME__'])(
    '%s, under the local prefix, is too',
    (p) => expect(isEngineBase(p)).toBe(true)
  )

  it.each(['__CODENAME__', '__SECRET__', '__PROJECT__', '__LOCALE__', '__LOCALX_VAR__'])(
    '%s is not',
    (p) => expect(isEngineBase(p)).toBe(false)
  )
})

// Third security review: patterns run on the engine's linear-time matcher
// (rule-pattern.test.ts), so "safe" means "that matcher accepts it". Shapes
// that freeze RegExp are accepted - they cannot freeze this matcher - and the
// constructs it cannot run are refused.
describe('isSafeRegex', () => {
  it.each([
    '^phoenix$',
    'foo',
    '^[a-z]+_id$',
    '^(?:alpha|beta)$',
    'a{2,5}',
    '(a+)+$',
    '((a+))+',
    '(a|aa)+$',
    '[^](x+)+]',
  ])('%s is accepted', (p) => expect(isSafeRegex(p)).toBe(true))

  it.each(['(a)\\1', '(?<n>a)\\k<n>', '(?=a)', '\\bx', 'a{1,1000}', '(', '[a-'])(
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
    ['an unsupported pattern', { ...replace, pattern: '(a)\\1' }],
    ['a placeholder that is not __NAME__', { ...replace, placeholder: 'CODENAME' }],
    ['a lower-case placeholder', { ...replace, placeholder: '__codename__' }],
    ['a reserved __P<n>__', { ...replace, placeholder: '__P3__' }],
    ['an engine base', { ...replace, placeholder: '__FN__' }],
    ['a redaction base', { ...replace, placeholder: `${REDACTION_PREFIX}X__` }],
    ['a replace rule with no placeholder', { ...replace, placeholder: undefined }],
  ])('refuses %s', (_label, rule) => {
    expect(ruleRefusal(rule as never)).toEqual(expect.any(String))
  })

  it('refuses a placeholder under the local prefix with the engine-base sentence', () => {
    expect(ruleRefusal({ ...replace, placeholder: '__LOCAL_K7Q2XA_VAR__' })).toMatch(
      /reserved for the engine's own names/
    )
    expect(ruleRefusal({ ...replace, placeholder: '__LOCAL_CODENAME__' })).toMatch(
      /reserved for the engine's own names/
    )
  })

  it('names the engine base in its sentence, as the server did', () => {
    expect(ruleRefusal({ ...replace, placeholder: '__FN__' })).toMatch(
      /reserved for the engine's own names/
    )
  })
})

// Spec 085 part 3, R2-7 (security audit run-2), Q5 = A (founder, 2026-11-09):
// a team whitelist is exact names only. One sealed `[A-Za-z_$][A-Za-z0-9_$]*`
// kept every identifier readable for every member.
describe('a team whitelist names the identifiers it keeps (R2-7)', () => {
  const wl = (pattern: string) => ({
    name: 'keep',
    type: 'whitelist' as const,
    pattern,
    enabled: true,
  })
  const REFUSAL =
    "A team whitelist must name the identifiers it keeps: `^Name$`, or `^(NameOne|NameTwo)$`. A pattern that matches names in general would send the whole team's names as written."

  it.each([
    '[A-Za-z_$][A-Za-z0-9_$]*',
    '.*',
    '^Pay.*$',
    '^[A-Z]\\w*$',
    'PaymentGateway',
    '^PaymentGateway',
    'PaymentGateway$',
    '^(PaymentGateway|.*)$',
    '^Payment|Gateway$',
    '^Pay(ment)?Gateway$',
    '^$',
    '^()$',
    '^Pay$Gateway$',
  ])('refuses %s for a team', (pattern) => {
    expect(ruleRefusal(wl(pattern), 'team')).toBe(REFUSAL)
  })

  it.each([
    '^PaymentGateway$',
    '^(PaymentGateway|ChargeCustomer)$',
    '^ZahlungsTür$',
    '^Πληρωμή$',
    '^Payment\\.Gateway$',
    '^payment_gateway_2$',
    '^\\$scope$',
  ])('accepts %s for a team', (pattern) => {
    expect(ruleRefusal(wl(pattern), 'team')).toBeNull()
  })

  it('leaves personal whitelists and every replace rule as before', () => {
    expect(ruleRefusal(wl('^Pay.*$'))).toBeNull()
    expect(ruleRefusal(wl('^Pay.*$'), 'personal')).toBeNull()
    expect(
      ruleRefusal(
        {
          name: 'r',
          type: 'replace',
          pattern: '^Pay.*$',
          placeholder: '__CODENAME__',
          enabled: true,
        },
        'team'
      )
    ).toBeNull()
  })

  it('a sealed WideOpen team rule opens refused, and is never sealed', async () => {
    const key = await importTeamKey(toBase64(new Uint8Array(32).fill(5)))
    const bind = { id: 'rule-1', teamId: 'team-1' }
    const env = await encryptTeamMap(key, {
      kind: 'veilio-rule',
      v: '1',
      id: 'rule-1',
      team: 'team-1',
      name: 'WideOpen',
      type: 'whitelist',
      pattern: '[A-Za-z_$][A-Za-z0-9_$]*',
      enabled: 'true',
    })
    expect(await openTeamRule([{ version: 1, key }], env, bind)).toEqual({
      ok: false,
      reason: 'refused',
      detail: REFUSAL,
    })
    await expect(sealTeamRule(key, wl('.*'), bind)).rejects.toThrow(REFUSAL)
  })
})
