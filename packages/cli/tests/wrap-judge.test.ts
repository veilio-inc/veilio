import { describe, it, expect } from 'vitest'
import { judgeWrap, wrapFrom, type JudgeInput } from '../src/client/wrap-judge.js'
import type { KeyPins } from '../src/key-pins.js'

// Spec 080 item 7a: the web app's wrap verdict (Cloud `frontend/src/lib/
// wrapTrust.ts`, spec 055 R-007), ported to a client with nobody to ask. Each
// case below is the web app's `wrapTrust.test.ts` case of the same name that
// applies without a member list: the CLI judges from its own key and the pins
// a person confirmed, never from who the server says is on the team.

const OWN = 'own-public-key'
const ME = 'me'

const pin = (current: string, history: string[] = []) => ({
  current,
  history,
  confirmedAt: '2026-11-01T00:00:00.000Z',
})

const judge = (from: string | undefined, wrappedBy: string | undefined, pins: KeyPins = {}) =>
  judgeWrap({ from, wrappedBy, ownPublicKey: OWN, ownId: ME, pins } satisfies JudgeInput)

describe('the wrap verdict (spec 055 R-007)', () => {
  it('1. a wrap whose granter key cannot be read is unreadable', () => {
    expect(wrapFrom('not json')).toBeUndefined()
    expect(judge(wrapFrom('not json'), 'ana').verdict).toBe('unreadable')
  })

  it('1. a wrap that names no granter key at all is unreadable, never trusted', () => {
    expect(judge(wrapFrom(JSON.stringify({ v: 1 })), ME).verdict).toBe('unreadable')
    expect(judge(wrapFrom(JSON.stringify({ v: 1, from: 7 })), ME).verdict).toBe('unreadable')
  })

  it('reads the granter key a wrap names', () => {
    expect(wrapFrom(JSON.stringify({ v: 1, from: 'ANA1' }))).toBe('ANA1')
  })

  it('2. a wrap made with our own derived key is trusted', () => {
    expect(judge(OWN, ME).verdict).toBe('trusted')
  })

  it('3. labelled as ours but made with another key: refused, and nothing to confirm', () => {
    const r = judge('SERVER', ME, { [ME]: pin('SERVER') })
    expect(r.verdict).toBe('refused-impersonation')
  })

  it('6. a granter whose current key was confirmed: trusted', () => {
    expect(judge('ANA1', 'ana', { ana: pin('ANA1') }).verdict).toBe('trusted')
  })

  it('8. a granter never confirmed: needs review, offering the key under their id', () => {
    expect(judge('ANA1', 'ana')).toEqual({
      verdict: 'needs-review',
      identity: 'ana',
      offered: 'ANA1',
    })
  })

  it('7. a key that differs from every confirmed key: refused, offering the change', () => {
    expect(judge('ANA2', 'ana', { ana: pin('ANA1') })).toEqual({
      verdict: 'refused-change',
      identity: 'ana',
      pinned: 'ANA1',
      offered: 'ANA2',
    })
  })
})

describe('legitimate history never breaks (spec 055 US3)', () => {
  it('a granter who has since left, whose key was confirmed, stays trusted: membership is not an input', () => {
    expect(judge('BOB1', 'bob', { bob: pin('BOB1') }).verdict).toBe('trusted')
  })

  it('a deleted account: needs review under the key itself, never an error', () => {
    expect(judge('GONE1', 'deleted-user')).toEqual({
      verdict: 'needs-review',
      identity: 'key:GONE1',
      offered: 'GONE1',
    })
  })

  it('a deleted account’s key, once confirmed by its fingerprint, is trusted', () => {
    expect(judge('GONE1', 'deleted-user', { 'key:GONE1': pin('GONE1') }).verdict).toBe('trusted')
  })

  it('the sentinel is never matched as an account: a pin under its name means nothing', () => {
    expect(judge('GONE1', 'deleted-user', { 'deleted-user': pin('GONE1') }).verdict).toBe(
      'needs-review'
    )
  })

  it('no granter named is judged like a deleted one, by the key', () => {
    expect(judge('K1', undefined)).toMatchObject({ verdict: 'needs-review', identity: 'key:K1' })
    expect(judge('K1', undefined, { 'key:K1': pin('K1') }).verdict).toBe('trusted')
  })

  it('after an honest key change is confirmed, versions under the earlier key stay trusted', () => {
    const pins = { ana: pin('ANA2', ['ANA1']) }
    expect(judge('ANA1', 'ana', pins).verdict).toBe('trusted')
    expect(judge('ANA2', 'ana', pins).verdict).toBe('trusted')
  })

  it('a change from a reset key names the CURRENT confirmed key as the one changed from', () => {
    expect(judge('ANA3', 'ana', { ana: pin('ANA2', ['ANA1']) })).toMatchObject({
      verdict: 'refused-change',
      pinned: 'ANA2',
    })
  })

  it('a key confirmed for ONE teammate does not vouch for a wrap labelled as another', () => {
    const r = judge('ANA1', 'bob', { ana: pin('ANA1'), bob: pin('BOB1') })
    expect(r.verdict).toBe('refused-change')
  })
})
