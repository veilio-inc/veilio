import { describe, it, expect } from 'vitest'
import { webcrypto } from 'node:crypto'
import {
  encryptMapForVault,
  encryptTeamMap,
  openRuleFromVault,
  openTeamRule,
  sealRuleForVault,
  sealTeamRule,
  type CryptoKeyLike,
  type RuleBody,
} from '../src/index.js'

// Spec 065: a rule is sealed under the customer's key before upload - the
// personal-maps key for a personal rule, the team key for a team rule - so
// Veilio cannot read it. Opening never throws on bad content: a tool that
// opens a teammate's rule must skip it and say so, never fail its masking.

const aes = (): Promise<CryptoKeyLike> =>
  webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]) as Promise<CryptoKeyLike>

const replace: RuleBody = {
  name: 'codename',
  type: 'replace',
  pattern: '^phoenix$',
  placeholder: '__CODENAME__',
  enabled: true,
}
const BIND = { id: 'r-1', teamId: null }
const TEAM_BIND = { id: 'r-2', teamId: 't-1' }
const whitelist: RuleBody = { name: 'keep', type: 'whitelist', pattern: '^keep$', enabled: false }

describe('a personal rule under the personal-maps key', () => {
  it.each([replace, whitelist])('round-trips %#', async (rule) => {
    const key = await aes()
    const env = await sealRuleForVault(key, rule, BIND)
    expect(JSON.stringify(env)).not.toContain('phoenix')
    expect(await openRuleFromVault(key, env, BIND)).toEqual({ ok: true, rule })
  })

  it('a wrong key is unopenable', async () => {
    const env = await sealRuleForVault(await aes(), replace, BIND)
    expect(await openRuleFromVault(await aes(), env, BIND)).toEqual({
      ok: false,
      reason: 'unopenable',
    })
  })

  it('a map envelope swapped into a rule row is not a rule', async () => {
    const key = await aes()
    const map = await encryptMapForVault(key, { __FN__1: 'settle' })
    expect(await openRuleFromVault(key, map, BIND)).toEqual({ ok: false, reason: 'not-a-rule' })
  })

  it('a damaged envelope is unopenable, never a throw', async () => {
    const key = await aes()
    for (const env of [null, 'x', { v: 2 }, { v: 1, alg: 'nope', iv: '', data: '' }])
      expect(await openRuleFromVault(key, env as never, BIND)).toEqual({
        ok: false,
        reason: 'unopenable',
      })
  })
})

describe('a team rule under the team key', () => {
  it('round-trips, with whichever held version fits', async () => {
    const v1 = await aes()
    const v2 = await aes()
    const env = await sealTeamRule(v1, replace, TEAM_BIND)
    const held = [
      { version: 2, key: v2 },
      { version: 1, key: v1 },
    ]
    expect(await openTeamRule(held, env, TEAM_BIND)).toEqual({ ok: true, rule: replace })
  })

  it('no held key opens it: unopenable', async () => {
    const env = await sealTeamRule(await aes(), replace, TEAM_BIND)
    expect(await openTeamRule([{ version: 1, key: await aes() }], env, TEAM_BIND)).toEqual({
      ok: false,
      reason: 'unopenable',
    })
    expect(await openTeamRule([], env, TEAM_BIND)).toEqual({ ok: false, reason: 'unopenable' })
  })

  it('a team map is not a rule', async () => {
    const key = await aes()
    const map = await encryptTeamMap(key, { __FN__1: 'settle' })
    expect(await openTeamRule([{ version: 1, key }], map, TEAM_BIND)).toEqual({
      ok: false,
      reason: 'not-a-rule',
    })
  })
})

describe('what opening refuses', () => {
  // Bodies a hostile or old client could seal: they open, and are refused.
  const sealRaw = async (body: Record<string, string>) => {
    const key = await aes()
    return { key, env: await encryptMapForVault(key, body) }
  }
  const base = {
    kind: 'veilio-rule',
    v: '1',
    id: 'r-1',
    team: '',
    name: 'n',
    type: 'replace',
    pattern: '^x$',
    placeholder: '__CODENAME__',
    enabled: 'true',
  }

  it.each([
    ['another kind', { ...base, kind: 'veilio-map' }, 'not-a-rule'],
    ['another version', { ...base, v: '2' }, 'not-a-rule'],
    ['a bad type', { ...base, type: 'delete' }, 'refused'],
    ['a bad enabled', { ...base, enabled: 'yes' }, 'refused'],
    ['an engine base', { ...base, placeholder: '__VAR__' }, 'refused'],
    ['a local-family base', { ...base, placeholder: '__LOCAL_K7Q2XA_VAR__' }, 'refused'],
    ['__P<n>__', { ...base, placeholder: '__P7__' }, 'refused'],
    ['an unsupported pattern', { ...base, pattern: '(?=a)a' }, 'refused'],
    ['an empty name', { ...base, name: '' }, 'refused'],
    ['a replace rule with no placeholder', { ...base, placeholder: '' }, 'refused'],
  ])('%s', async (_label, body, reason) => {
    const { key, env } = await sealRaw(body)
    expect(await openRuleFromVault(key, env, BIND)).toMatchObject({ ok: false, reason })
  })

  it('a refusal says why', async () => {
    const { key, env } = await sealRaw({ ...base, placeholder: '__VAR__' })
    const opened = await openRuleFromVault(key, env, BIND)
    expect(opened.ok === false && opened.detail).toMatch(/engine/)
  })
})

// Security review (2026-10-30): the server cannot read a rule, but it could
// move a sealed body to another of the same person's rows - a strict replace
// rule overwritten by a copy of a whitelist one. The body names its row.
describe('a sealed rule is bound to its row', () => {
  it('opened as another row: refused', async () => {
    const key = await aes()
    const env = await sealRuleForVault(key, replace, BIND)
    expect(await openRuleFromVault(key, env, { id: 'r-9', teamId: null })).toEqual({
      ok: false,
      reason: 'refused',
      detail: 'sealed for another rule',
    })
  })

  it('a team rule opened for another team, or as a personal rule: refused', async () => {
    const key = await aes()
    const env = await sealTeamRule(key, replace, TEAM_BIND)
    const held = [{ version: 1, key }]
    for (const bind of [
      { id: 'r-2', teamId: 't-2' },
      { id: 'r-2', teamId: null },
    ])
      expect(await openTeamRule(held, env, bind)).toMatchObject({
        ok: false,
        reason: 'refused',
      })
  })

  it('a body with no row named: refused', async () => {
    const key = await aes()
    const unbound = {
      kind: 'veilio-rule',
      v: '1',
      team: '',
      name: 'n',
      type: 'whitelist',
      pattern: '^x$',
      enabled: 'true',
    }
    const env = await encryptMapForVault(key, unbound)
    expect(await openRuleFromVault(key, env, BIND)).toMatchObject({ ok: false, reason: 'refused' })
  })
})
