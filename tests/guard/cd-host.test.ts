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
  test('after cd sub the host says sub: the next relative read is judged from sub', async () => {
    const g = await fixtureGuard()
    g.atHost(ROOT)
    await call(g, 'cd sub')
    g.atHost(`${ROOT}/sub`)
    expect(await call(g, 'cat notes')).toBe(NOTES)
    expect(g.notices).toEqual([])
  })

  test('the host reset the shell to the root after a cd outside the project: the root is used', async () => {
    const g = await fixtureGuard()
    g.atHost(ROOT)
    await call(g, 'cd /tmp')
    g.atHost(ROOT)
    // Both checked: the host's root and the guard's /tmp; root/notes is plain.
    expect(await call(g, 'cat notes')).toBeUndefined()
    expect(await call(g, 'cat sub/notes')).toBe(
      'Veilio keeps sub/notes away from the model. Ask the user for what you need from it.'
    )
    expect(g.notices).toHaveLength(1)
    expect(g.notices[0]).toContain(`Claude Code says the shell is in ${ROOT}`)
  })

  test('a disagreement: the host is used and both are checked; logged once', async () => {
    const g = await fixtureGuard()
    g.atHost(ROOT)
    await call(g, 'ls')
    // The guard read no cd, the host says sub: sub is checked.
    g.atHost(`${ROOT}/sub`)
    expect(await call(g, 'cat notes')).toBe(NOTES)
    g.atHost(ROOT)
    g.atHost(`${ROOT}/sub`)
    expect(g.notices).toHaveLength(1)
  })

  test('the carry while the host reports is where the call most likely ended', async () => {
    const g = await fixtureGuard()
    g.atHost(ROOT)
    await call(g, 'cd sub')
    await call(g, 'cd x')
    g.atHost(`${ROOT}/sub/x`)
    // Not the fallback's {sub, sub/x}: the host and the inference agree.
    expect(await call(g, 'cat notes')).toBeUndefined()
    expect(g.notices).toEqual([])
  })

  test('past the bound the host alone is used', async () => {
    const g = await fixtureGuard()
    // {root, sub} x 2 x 2 x 2: 16 inferred directories, sub among them.
    for (const c of ['cd sub', 'cd d0', 'cd d1', 'cd d2']) expect(await call(g, c)).toBeUndefined()
    expect(await call(g, 'cat notes')).toBe(NOTES)
    g.atHost(`${ROOT}/x`)
    // With the host's 17th the union is over the bound: x alone, so sub's notes is not read.
    expect(await call(g, 'cat notes')).toBeUndefined()
  })
})
