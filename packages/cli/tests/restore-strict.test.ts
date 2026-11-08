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

async function run(
  stdin: string,
  argv: string[] = ['restore'],
  own: Record<string, string> = OWN,
  home?: string
) {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-strict-'))
  if (Object.keys(own).length) saveMap(resolveMapPath(null, cwd), own)
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => stdin,
    stdinBytes: async function* () {
      yield Buffer.from(stdin)
    },
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  }
  const code = await main(argv, io)
  return { code, out, err }
}

describe('restore, without --strict', () => {
  it('names a redacted value, even under --quiet, and still writes the text', async () => {
    for (const argv of [['restore'], ['restore', '--quiet']]) {
      const r = await run("throw new __CLS__1('__REDACTED_CREDENTIAL_1__')", argv)
      expect(r.code).toBe(EXIT_OK)
      expect(r.out).toBe("throw new PaymentGateway('__REDACTED_CREDENTIAL_1__')")
      expect(r.err).toMatch(
        /__REDACTED_CREDENTIAL_1__[\s\S]*cannot be restored[\s\S]*do not write/i
      )
    }
  })

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

  // Spec 067 benchmark: a file restored with a redaction in it was written over
  // the original, and its tests failed - a redacted value is gone for good, so
  // the restored text is not the file. --strict withholds it.
  it('a redacted value: nothing written, exit 1, and the redaction named', async () => {
    const r = await run('new __CLS__1(__REDACTED_STRIPE_KEY_1__)', ['restore', '--strict'])
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.out).toBe('')
    expect(r.err).toMatch(/--strict: nothing written - __REDACTED_STRIPE_KEY_1__/)
    // Nothing was written, so no advice about writing it.
    expect(r.err).not.toMatch(/do not write/)
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
    expect(r.err).toMatch(
      /give this placeholder different identifiers[\s\S]*--strict: nothing written - __CLS__1/
    )
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

describe('redactionsIn (spec 067)', () => {
  it('finds numbered and un-numbered redactions, once each, in order', async () => {
    const { redactionsIn } = await import('../src/reservations.js')
    expect(
      redactionsIn('a __REDACTED_IBAN__ b __REDACTED_AWS_KEY_1__ c __REDACTED_AWS_KEY_1__')
    ).toEqual(['__REDACTED_IBAN__', '__REDACTED_AWS_KEY_1__'])
  })
  it("inside a longer name too: a rule's residue is still a value gone for good", async () => {
    const { redactionsIn } = await import('../src/reservations.js')
    expect(redactionsIn('k = "__REDACTED_AWS_SECRET_1__3"')).toEqual(['__REDACTED_AWS_SECRET_1__'])
  })
})

describe('redactedNote (spec 067)', () => {
  it('does not call personal data a credential', async () => {
    const { redactedNote } = await import('../src/reservations.js')
    expect(redactedNote(['__REDACTED_EMAIL_1__'])).not.toMatch(/as a credential/)
    expect(redactedNote(['__REDACTED_EMAIL_1__'])).toMatch(/cannot be restored/)
  })
})
