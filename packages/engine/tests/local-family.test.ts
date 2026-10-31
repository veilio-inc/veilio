import { describe, it, expect } from 'vitest'
import {
  LOCAL_PREFIX,
  MANUAL_BASE,
  REGULATED_BASES,
  ROLE_BASES,
  highestPerKind,
  isLocalPlaceholder,
  isPlaceholder,
  isRolePlaceholder,
  localBaseOf,
  numbersLeft,
  teamBaseOf,
  usableBlocks,
} from '../src/index.js'

// Spec 066 R2: names a checkout numbers while it holds no team block get
// `__LOCAL_<TAG>_<KIND>__n`, a family no team map ever holds.

describe('isLocalPlaceholder', () => {
  it.each(['__LOCAL_K7Q2XA_VAR__3', '__LOCAL_K7Q2XA_API_KEY__1', '__LOCAL_000000_CLS__12'])(
    '%s is one',
    (t) => {
      expect(isLocalPlaceholder(t)).toBe(true)
      // ...and an ordinary placeholder to the rest of the engine.
      expect(isPlaceholder(t)).toBe(true)
    }
  )

  it.each([
    ['no number', '__LOCAL_K7Q2XA_VAR__'],
    ['a 5-character tag', '__LOCAL_K7Q2X_VAR__3'],
    ['a 7-character tag', '__LOCAL_K7Q2XAB_VAR__3'],
    ['a lowercase tag', '__LOCAL_k7q2xa_VAR__3'],
    ['a team placeholder', '__VAR__3'],
    ['another prefix', '__LOCALX_VAR__1'],
    ['no kind', '__LOCAL_K7Q2XA___3'],
    ['a kind that starts with a digit', '__LOCAL_K7Q2XA_9X__3'],
    ['text around it', 'x__LOCAL_K7Q2XA_VAR__3'],
    ['a trailing letter', '__LOCAL_K7Q2XA_VAR__3a'],
  ])('%s is not', (_label, t) => expect(isLocalPlaceholder(t)).toBe(false))

  it('the prefix is the one the contract names', () => {
    expect(LOCAL_PREFIX).toBe('__LOCAL_')
  })
})

describe('localBaseOf / teamBaseOf', () => {
  it('builds the local base of a team base', () => {
    expect(localBaseOf('__VAR__', 'K7Q2XA')).toBe('__LOCAL_K7Q2XA_VAR__')
    expect(localBaseOf('__API_KEY__', 'K7Q2XA')).toBe('__LOCAL_K7Q2XA_API_KEY__')
  })

  it('throws on a local base: a local base never gets a second tag', () => {
    expect(() => localBaseOf('__LOCAL_K7Q2XA_VAR__', 'ABCDEF')).toThrow(TypeError)
    expect(() => localBaseOf('__LOCAL_X__', 'ABCDEF')).toThrow(TypeError)
  })

  it.each(['', 'K7Q2X', 'K7Q2XAB', 'k7q2xa', 'K7Q2X_', 'K7Q2X-'])('throws on the tag %j', (tag) =>
    expect(() => localBaseOf('__VAR__', tag)).toThrow(TypeError)
  )

  it.each(['VAR__', '__VAR', '__var__', '__VAR__3', 'plain'])('throws on the base %j', (base) =>
    expect(() => localBaseOf(base, 'K7Q2XA')).toThrow(TypeError)
  )

  it.each([
    ...Object.values(ROLE_BASES),
    ...(Object.values(REGULATED_BASES) as string[]),
    MANUAL_BASE,
    '__API_KEY__',
  ])('teamBaseOf inverts localBaseOf for %s', (base) => {
    expect(teamBaseOf(localBaseOf(base, 'K7Q2XA'))).toBe(base)
  })

  it.each([
    '__VAR__',
    '__LOCAL_K7Q2XA_VAR__3',
    '__LOCAL_K7Q2X_VAR__',
    '__LOCAL_k7q2xa_VAR__',
    '__LOCALX_K7Q2XA_VAR__',
    '__LOCAL_K7Q2XA___',
    '__LOCAL_K7Q2XAVAR__',
    'x__LOCAL_K7Q2XA_VAR__',
    '',
  ])('teamBaseOf(%j) is null', (s) => expect(teamBaseOf(s)).toBeNull())
})

describe('isRolePlaceholder', () => {
  it.each([
    '__CLS__1',
    '__FN__2',
    '__PKG__3',
    '__VAR__4',
    '__STR__5',
    '__LOCAL_K7Q2XA_CLS__1',
    '__LOCAL_K7Q2XA_FN__2',
    '__LOCAL_K7Q2XA_PKG__3',
    '__LOCAL_K7Q2XA_VAR__4',
    '__LOCAL_K7Q2XA_STR__5',
  ])('%s is a role placeholder', (t) => expect(isRolePlaceholder(t)).toBe(true))

  it.each([
    '__IBAN__1',
    '__LOCAL_K7Q2XA_IBAN__1',
    '__MANUAL__1',
    '__CODENAME__1',
    '__VAR__',
    '__LOCAL_K7Q2XA_VAR__',
    '__LOCAL_K7Q2X_VAR__1',
    '__VARX__1',
    'x__VAR__1',
  ])('%s is not', (t) => expect(isRolePlaceholder(t)).toBe(false))
})

// Ported from the guard's band (plugins/veilio-guard/tests/team-numbers.test.ts),
// where these helpers lived until spec 066.
describe('usableBlocks / numbersLeft / highestPerKind', () => {
  const BLOCKS = {
    __CLS__: { start: 5001, end: 5500 },
    __FN__: { start: 7001, end: 7500 },
  }

  it('highestPerKind keys the highest number by base, local bases apart', () => {
    expect(
      highestPerKind({
        __CLS__3: 'a',
        __CLS__12: 'b',
        __FN__2: 'c',
        __DEV__: 'd',
        __LOCAL_K7Q2XA_CLS__40: 'e',
      })
    ).toEqual({ __CLS__: 12, __FN__: 2, __LOCAL_K7Q2XA_CLS__: 40 })
  })

  it('an empty map: every block is usable and every number left', () => {
    expect(usableBlocks({}, BLOCKS)).toEqual(BLOCKS)
    expect(numbersLeft({}, { __CLS__: BLOCKS.__CLS__ })).toBe(500)
    expect(numbersLeft({}, BLOCKS)).toBe(1000)
  })

  it('a map number below the block leaves the block whole', () => {
    expect(numbersLeft({ __CLS__40: 'x' }, { __CLS__: BLOCKS.__CLS__ })).toBe(500)
  })

  it('a map number inside the block: what is above it', () => {
    expect(numbersLeft({ __CLS__5100: 'x' }, { __CLS__: BLOCKS.__CLS__ })).toBe(400)
    expect(usableBlocks({ __CLS__5499: 'x' }, BLOCKS)).toEqual(BLOCKS)
    expect(numbersLeft({ __CLS__5499: 'x' }, { __CLS__: BLOCKS.__CLS__ })).toBe(1)
  })

  it('a block the map has outgrown is not usable, and never counts as numbers left', () => {
    expect(usableBlocks({ __CLS__6000: 'x' }, BLOCKS)).toEqual({ __FN__: BLOCKS.__FN__ })
    expect(numbersLeft({ __CLS__6000: 'x' }, { __CLS__: BLOCKS.__CLS__ })).toBe(0)
    // At the end itself the block is used up.
    expect(usableBlocks({ __CLS__5500: 'x' }, BLOCKS)).toEqual({ __FN__: BLOCKS.__FN__ })
  })

  it('local entries never use up a team block', () => {
    expect(numbersLeft({ __LOCAL_K7Q2XA_CLS__9000: 'x' }, { __CLS__: BLOCKS.__CLS__ })).toBe(500)
  })
})
