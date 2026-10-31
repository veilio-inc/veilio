import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/index.js'
import { NUMBERING_CORPUS } from './fixtures/numbering-corpus.js'

// Spec 066 R3: `team: { blocks, tag }` decides where every new number comes
// from - inside a usable reserved block, or from the checkout's local family.

describe('without `team`, numbering is unchanged (065)', () => {
  // Snapshot written by the 065 engine, before the option existed.
  it('masks the corpus byte-identically', async () => {
    const out = NUMBERING_CORPUS.map(([name, code, opts]) => {
      const { anonymized, map } = anonymize(code, opts)
      return { name, anonymized, map }
    })
    await expect(JSON.stringify(out, null, 2) + '\n').toMatchFileSnapshot(
      './fixtures/numbering-corpus.065.json'
    )
  })
})

const TAG = 'K7Q2XA'
const LOCAL_VAR = `__LOCAL_${TAG}_VAR__`

/** `count` distinct variables, none an ordinary word. */
const vars = (count: number, stem = 'skerry') =>
  Array.from({ length: count }, (_, i) => `const ${stem}${'Q'.repeat(i + 1)}x = ${i}`).join('\n') +
  '\n'

const keysOf = (map: Record<string, string>, given: Record<string, string> = {}) =>
  Object.keys(map)
    .filter((k) => !(k in given))
    .sort()

const numbered = (base: string, ns: number[]) => ns.map((n) => `${base}${n}`).sort()

const team = (blocks: Record<string, { start: number; end: number }>, tag = TAG) => ({
  blocks,
  tag,
})

describe('`team`: a usable block', () => {
  it('numbers new names from the block start when the map is below it', () => {
    const existingMap = { __VAR__40: 'olderName' }
    const { map } = anonymize(vars(3), {
      language: 'typescript',
      existingMap,
      team: team({ __VAR__: { start: 5001, end: 5500 } }),
    })
    expect(keysOf(map, existingMap)).toEqual(numbered('__VAR__', [5001, 5002, 5003]))
  })

  it('numbers from the map’s highest + 1 when that is inside the block', () => {
    const existingMap = { __VAR__5010: 'olderName' }
    const { map } = anonymize(vars(2), {
      language: 'typescript',
      existingMap,
      team: team({ __VAR__: { start: 5001, end: 5500 } }),
    })
    expect(keysOf(map, existingMap)).toEqual(numbered('__VAR__', [5011, 5012]))
  })

  it('a block that runs out partway through one call sends the rest local', () => {
    const { map } = anonymize(vars(5), {
      language: 'typescript',
      team: team({ __VAR__: { start: 5001, end: 5002 } }),
    })
    expect(keysOf(map)).toEqual(
      [...numbered('__VAR__', [5001, 5002]), ...numbered(LOCAL_VAR, [1, 2, 3])].sort()
    )
  })

  it('the last number of a block is still used', () => {
    const existingMap = { __VAR__5499: 'olderName' }
    const { map } = anonymize(vars(2), {
      language: 'typescript',
      existingMap,
      team: team({ __VAR__: { start: 5001, end: 5500 } }),
    })
    expect(keysOf(map, existingMap)).toEqual([`${LOCAL_VAR}1`, '__VAR__5500'].sort())
  })
})

describe('`team`: no usable block', () => {
  it('the map’s highest above the block’s end: every new name is local', () => {
    const existingMap = { __VAR__6000: 'teammatesName' }
    const { map } = anonymize(vars(3), {
      language: 'typescript',
      existingMap,
      team: team({ __VAR__: { start: 5001, end: 5500 } }),
    })
    expect(keysOf(map, existingMap)).toEqual(numbered(LOCAL_VAR, [1, 2, 3]))
  })

  it('no block for the kind: local, while a kind with one numbers inside it', () => {
    const { map } = anonymize('class QuaywardPlan {}\n' + vars(2), {
      language: 'typescript',
      team: team({ __CLS__: { start: 9001, end: 9500 } }),
    })
    expect(keysOf(map)).toEqual(['__CLS__9001', ...numbered(LOCAL_VAR, [1, 2])].sort())
  })

  it('no blocks at all: every kind local', () => {
    const { anonymized, map } = anonymize('class QuaywardPlan {}\nfunction quaywardRun() {}\n', {
      language: 'typescript',
      team: team({}),
    })
    expect(keysOf(map)).toEqual([`__LOCAL_${TAG}_CLS__1`, `__LOCAL_${TAG}_FN__1`])
    expect(anonymized).toBe(`class __LOCAL_${TAG}_CLS__1 {}\nfunction __LOCAL_${TAG}_FN__1() {}\n`)
  })

  it('a block of another kind is never used for this one', () => {
    const { map } = anonymize(vars(1), {
      language: 'typescript',
      team: team({ __FN__: { start: 1, end: 500 } }),
    })
    expect(keysOf(map)).toEqual([`${LOCAL_VAR}1`])
  })
})

describe('`team`: every mint site obeys the rule', () => {
  const code = [
    'const acct = "DE89370400440532013000"',
    '// Janina Kowalska',
    'const codenameHarbour = 5',
    '',
  ].join('\n')
  const rules = [
    {
      id: 'r',
      scope: 'team' as const,
      team_id: 't',
      name: 'codename',
      type: 'replace' as const,
      pattern: '^codename',
      placeholder: '__CODENAME__',
      enabled: true,
      sort_order: 0,
    },
  ]
  const opts = { language: 'typescript' as const, manual: ['Janina Kowalska'], rules }
  const blocks = {
    __VAR__: { start: 101, end: 600 },
    __IBAN__: { start: 201, end: 700 },
    __MANUAL__: { start: 301, end: 800 },
    __CODENAME__: { start: 401, end: 900 },
  }

  it('inside each kind’s block', () => {
    const { map } = anonymize(code, { ...opts, team: team(blocks) })
    expect(map).toEqual({
      __VAR__101: 'acct',
      __IBAN__201: 'DE89370400440532013000',
      __MANUAL__301: 'Janina Kowalska',
      __CODENAME__401: 'codenameHarbour',
    })
  })

  it('local for each kind without one', () => {
    const { anonymized, map } = anonymize(code, { ...opts, team: team({}) })
    expect(map).toEqual({
      [`${LOCAL_VAR}1`]: 'acct',
      [`__LOCAL_${TAG}_IBAN__1`]: 'DE89370400440532013000',
      [`__LOCAL_${TAG}_MANUAL__1`]: 'Janina Kowalska',
      [`__LOCAL_${TAG}_CODENAME__1`]: 'codenameHarbour',
    })
    expect(anonymized).not.toMatch(/acct|DE8937|Janina|codenameHarbour/)
    expect(restore(anonymized, map).restored).toBe(code)
  })

  it('a local manual mark is replayed by the next pass, like a team one', () => {
    const first = anonymize(code, { ...opts, team: team({}) })
    const second = anonymize('// Janina Kowalska again\n', {
      language: 'typescript',
      existingMap: first.map,
      team: team({}),
    })
    expect(second.anonymized).toBe(`// __LOCAL_${TAG}_MANUAL__1 again\n`)
  })
})

describe('`team`: the local counter', () => {
  it('starts above the map’s highest of that local base', () => {
    const existingMap = { [`${LOCAL_VAR}7`]: 'olderName' }
    const { map } = anonymize(vars(2), { language: 'typescript', existingMap, team: team({}) })
    expect(keysOf(map, existingMap)).toEqual(numbered(LOCAL_VAR, [8, 9]))
  })

  it('starts above a local placeholder already in the text', () => {
    const { map } = anonymize(`// see ${LOCAL_VAR}4\n${vars(1)}`, {
      language: 'typescript',
      team: team({}),
    })
    expect(keysOf(map)).toEqual([`${LOCAL_VAR}5`])
  })

  it('two tags number independently', () => {
    const existingMap = { __LOCAL_ZZZZZZ_VAR__9: 'othersName' }
    const { map } = anonymize(vars(1), { language: 'typescript', existingMap, team: team({}) })
    expect(keysOf(map, existingMap)).toEqual([`${LOCAL_VAR}1`])
  })

  it('the team counter never moves for a local name', () => {
    const existingMap = { __VAR__3: 'olderName' }
    const first = anonymize(vars(1), { language: 'typescript', existingMap, team: team({}) })
    const { map } = anonymize(vars(1, 'quayward'), {
      language: 'typescript',
      existingMap: first.map,
      team: team({ __VAR__: { start: 4, end: 500 } }),
    })
    expect(keysOf(map, first.map)).toEqual(['__VAR__4'])
  })
})

describe('`team`: names already mapped', () => {
  it('keep their placeholder, team or local, whatever the blocks say', () => {
    const existingMap = { __VAR__12: 'skerryQx', [`${LOCAL_VAR}3`]: 'skerryQQx' }
    const { anonymized, map } = anonymize(vars(2), {
      language: 'typescript',
      existingMap,
      team: team({ __VAR__: { start: 5001, end: 5500 } }),
    })
    expect(map).toEqual(existingMap)
    expect(anonymized).toBe(`const __VAR__12 = 0\nconst ${LOCAL_VAR}3 = 1\n`)
  })
})

describe('`team`: the option itself', () => {
  it.each(['', 'K7Q2X', 'K7Q2XAB', 'k7q2xa', 7, null, undefined])(
    'a tag of %j raises TypeError and mints nothing',
    (tag) => {
      expect(() =>
        anonymize(vars(1), {
          language: 'typescript',
          // A block that takes every name: the tag is checked before any minting.
          team: { blocks: { __VAR__: { start: 1, end: 500 } }, tag: tag as string },
        })
      ).toThrow(
        expect.objectContaining({ name: 'TypeError', message: expect.stringMatching(/tag/) })
      )
    }
  )

  it('is a known option, and an unknown key beside it still throws', () => {
    expect(() => anonymize(vars(1), { team: team({}) })).not.toThrow()
    expect(() => anonymize(vars(1), { team: team({}), teem: 1 } as never)).toThrow(/teem/)
  })

  it('round-trips: the minting checkout restores its own text', () => {
    const code = 'class QuaywardPlan {}\n' + vars(4)
    const { anonymized, map } = anonymize(code, {
      language: 'typescript',
      team: team({ __VAR__: { start: 1, end: 2 } }),
    })
    expect(restore(anonymized, map).restored).toBe(code)
  })
})
