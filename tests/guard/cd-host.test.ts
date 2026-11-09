import { describe, expect, test } from 'vitest'
import { fixtureGuard, ROOT } from './fixtures/cd-project.ts'
import type { Guard } from '../../plugins/veilio-guard/lib/guard.ts'

// Spec 086 FR-011 (review #3, the coordinator's conditions): where the shell
// is as a call starts. The host's report is the truth; with none, every
// directory the last call may have left the shell in is carried, and the
// bound refuses a call that would pass it.
const ran = { result: { stdout: '', stderr: '', interrupted: false } }
async function call(g: Guard, command: string): Promise<string | undefined> {
  const v = await g.beforeTool({ tool: 'Bash', command, description: 'x' })
  if ('deny' in v) return v.deny
  await g.afterTool('Bash', v.args, ran)
  return undefined
}
const NOTES = 'Veilio keeps notes away from the model. Ask the user for what you need from it.'

describe('no host directory: the fallback carries every outcome', () => {
  test('a cd that may fail: the next call is checked where it was and where it went', async () => {
    const g = await fixtureGuard()
    expect(await call(g, 'cd sub')).toBeUndefined()
    expect(await call(g, 'cd x')).toBeUndefined()
    // sub/notes is a link to .env: refused only if sub is still carried.
    expect(await call(g, 'cat notes')).toBe(NOTES)
  })

  test('the bound: a call that would leave the shell in more than 16 directories is refused', async () => {
    const g = await fixtureGuard()
    for (const d of ['d0', 'd1', 'd2', 'd3']) expect(await call(g, `cd ${d}`)).toBeUndefined()
    expect(await call(g, 'cd d4')).toBe(
      'Veilio refused this call: Veilio cannot tell where `cd d4` takes the shell (too many possible directories), so a later command could read a file Veilio keeps away from the model. Use cd with a plain path, or name the files by their full path.'
    )
  })
})

describe('the host reports the directory', () => {
  test('a report that never moves (always the root) is not trusted: every outcome is carried', async () => {
    const g = await fixtureGuard()
    g.atHost(ROOT)
    await call(g, 'cd sub')
    g.atHost(ROOT)
    await call(g, 'cd /tmp')
    g.atHost(ROOT)
    // Trusted, the root alone (with /tmp) would be read; sub is still possible.
    expect(await call(g, 'cat notes')).toBe(NOTES)
    expect(g.notices).toEqual([])
  })

  test('proved live (it named sub after the cd the guard saw): the next call is read from it', async () => {
    const g = await fixtureGuard()
    g.atHost(ROOT)
    await call(g, 'cd sub')
    g.atHost(`${ROOT}/sub`)
    expect(await call(g, 'cat notes')).toBe(NOTES)
    await call(g, 'cd ..')
    g.atHost(ROOT)
    // From the host alone: the root, where notes is a plain file.
    expect(await call(g, 'cat notes')).toBeUndefined()
    expect(g.notices).toEqual([])
  })

  test('proved, then reset to the root after a cd outside the project: both read, logged once', async () => {
    const g = await fixtureGuard()
    await call(g, 'cd sub')
    g.atHost(`${ROOT}/sub`)
    await call(g, 'cd /tmp')
    g.atHost(ROOT)
    expect(await call(g, 'cat notes')).toBeUndefined()
    expect(await call(g, 'cat sub/notes')).toBe(
      'Veilio keeps sub/notes away from the model. Ask the user for what you need from it.'
    )
    expect(g.notices).toEqual([
      `Veilio guard: Claude Code says the shell is in ${ROOT}, where Veilio's reading of the last command left it in /tmp. Both are checked for this call.`,
    ])
  })

  test('proved, and the host and the walk together past the bound: refused, not narrowed', async () => {
    const g = await fixtureGuard()
    await call(g, 'cd sub')
    g.atHost(`${ROOT}/sub`)
    await call(g, 'ls')
    g.atHost(`${ROOT}/sub`)
    const fan = Array.from({ length: 16 }, (_, k) => `cd d${k}`).join(' || ')
    expect(await call(g, fan)).toBeUndefined()
    g.atHost(`${ROOT}/elsewhere`)
    expect(await call(g, 'ls')).toBe(
      'Veilio refused this call: Veilio cannot tell where `ls` takes the shell (too many possible directories), so a later command could read a file Veilio keeps away from the model. Use cd with a plain path, or name the files by their full path.'
    )
  })

  const dirs = (g: Guard) => [...(g as unknown as { dirs: { dirs: string[] } }).dirs.dirs].sort()

  test("a report never proved is not discarded: it joins the walk's directories", async () => {
    const g = await fixtureGuard()
    await call(g, 'ls')
    g.atHost(`${ROOT}/sub`)
    expect(dirs(g)).toEqual([ROOT, `${ROOT}/sub`])
    expect(await call(g, 'cat notes')).toBe(NOTES)
  })

  test('the proving call keeps both; the host alone from the next call', async () => {
    const g = await fixtureGuard()
    await call(g, 'cd sub')
    g.atHost(`${ROOT}/sub`)
    expect(dirs(g)).toEqual([ROOT, `${ROOT}/sub`])
    await call(g, 'ls')
    g.atHost(`${ROOT}/sub`)
    expect(dirs(g)).toEqual([`${ROOT}/sub`])
  })

  test('proved only by the one directory the walk most likely ended in, not any it may have', async () => {
    const g = await fixtureGuard()
    await call(g, 'cd sub || cd src')
    g.atHost(`${ROOT}/sub`)
    await call(g, 'ls')
    g.atHost(`${ROOT}/sub`)
    expect(dirs(g)).toContain(`${ROOT}/src`)
  })
})
