import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_FINDINGS, EXIT_OK, type Io } from '../src/commands.js'
import { saveMap, resolveMapPath } from '../src/store.js'
import { mapsFor, teamScenario } from './helpers/team-scenario.js'

/**
 * `veilio restore --strict`, and altered placeholders.
 *
 * A reader asked what happens on the way back when the model hands over a patch
 * with a placeholder it invented or half-copied: "an unmapped or
 * half-hallucinated token there becomes a silently wrong edit rather than a loud
 * failure. Refuse or pass through?" Restore passes it through and names it;
 * --strict refuses - nothing on stdout, exit 1 - so a pipeline cannot write a
 * file that still holds a placeholder. And a placeholder whose SHAPE the model
 * changed (`__fn__1`, `_FN__1`) was passed through without a word: it is named
 * now, both ways. The rule itself is the engine's (engine/tests/altered.test.ts).
 */
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const OWN = { __CLS__1: 'PaymentGateway', __FN__1: 'chargeCard' }

async function run(stdin: string, argv: string[] = ['restore'], own = OWN, home?: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-strict-'))
  if (Object.keys(own).length) saveMap(resolveMapPath(null, cwd), own)
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => stdin,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  }
  const code = await main(argv, io)
  return { code, out, err }
}

describe('restore, without --strict', () => {
  it('names an altered placeholder instead of passing it silently, and still writes the text', async () => {
    const r = await run('new __CLS__1().__fn__1()')
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toBe('new PaymentGateway().__fn__1()')
    expect(r.err).toMatch(/__fn__1[\s\S]*shape the AI changed/)
  })

  it('names it under --quiet too: it is a finding, not the summary', async () => {
    const r = await run('x.__fn__1()', ['restore', '--quiet'])
    expect(r.err).toMatch(/__fn__1/)
  })
})

describe('restore --strict', () => {
  it('a clean restore: written as usual, exit 0', async () => {
    const r = await run('new __CLS__1().__FN__1()', ['restore', '--strict'])
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toBe('new PaymentGateway().chargeCard()')
  })

  it.each([
    ['an invented placeholder', 'new __CLS__1().__FN__9()', '__FN__9'],
    ['an altered one', 'new __CLS__1().__fn__1()', '__fn__1'],
  ])('%s: nothing written, named, exit 1', async (_what, text, token) => {
    const r = await run(text, ['restore', '--strict'])
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.out).toBe('')
    expect(r.err).toContain(token)
    expect(r.err).toMatch(/--strict: nothing written/)
    expect(r.err).not.toMatch(/still in the output/)
  })

  it('a real name shaped like a placeholder (_str_1), restored exactly: written, exit 0', async () => {
    const r = await run('__VAR__1 = __CLS__1()', ['restore', '--strict'], {
      ...OWN,
      __VAR__1: '_str_1',
    })
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toBe('_str_1 = PaymentGateway()')
  })

  it('a credential redacted on purpose is not a failure', async () => {
    const r = await run('new __CLS__1(__REDACTED_STRIPE_KEY_1__)', ['restore', '--strict'])
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toBe('new PaymentGateway(__REDACTED_STRIPE_KEY_1__)')
  })

  it("a placeholder the team's maps disagree on: nothing written, exit 1", async () => {
    const maps = mapsFor({
      namespace: { __FN__90: 'seedAlphaLedger' },
      aliases: {},
      conflicts: { __FN__90: 2 },
    })
    const { home } = await teamScenario(fetchMock, { maps })
    const r = await run('a.__FN__90()', ['restore', '--strict'], OWN, home)
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.out).toBe('')
    expect(r.err).toMatch(/__FN__90/)
  })

  it('a placeholder numbered locally, which the team numbers differently: nothing written, exit 1', async () => {
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: { __CLS__1: 'Bar' }, aliases: {}, conflicts: {} }),
    })
    const r = await run('new __CLS__1()', ['restore', '--strict'], { __CLS__1: 'Foo' }, home)
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.out).toBe('')
    expect(r.err).toMatch(/numbered it locally[\s\S]*--strict: nothing written - __CLS__1/)
  })

  it("the team's maps could not be used (key locked): nothing written, exit 1", async () => {
    const maps = mapsFor({ namespace: { __FN__7: 'settleLedger' }, aliases: {}, conflicts: {} })
    const { home } = await teamScenario(fetchMock, { maps, locked: true })
    const r = await run('x.__FN__7()', ['restore', '--strict'], OWN, home)
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.out).toBe('')
    expect(r.err).toMatch(/veilio team unlock/)
  })
})
