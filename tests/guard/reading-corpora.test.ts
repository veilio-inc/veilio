import { expect, test } from 'vitest'
import { ATTACK, GLUED, LIMITS, MENTIONS, ORDINARY, ZSH } from './fixtures/reading-corpora.ts'
import { guardAt, memoryFixture, verdict } from './fixtures/reading-shell.ts'

// Spec 091, rules R3 and R4 of the reading table: the ordinary corpus runs,
// the attack corpus is refused, the documented limits run. Judged only, never
// executed, so this runs on every platform.
const fixture = memoryFixture()
const refused = async (
  commands: readonly string[],
  rawOnly: readonly string[],
  tool: 'Bash' | 'PowerShell' = 'Bash'
) => {
  const out: string[] = []
  for (const c of commands)
    if ((await verdict(await guardAt(fixture, rawOnly), c, tool)).verdict === 'refused')
      out.push(JSON.stringify(c))
  return out
}

test('the corpora are what the reading table asks for', () => {
  expect(ORDINARY.length).toBeGreaterThanOrEqual(200)
  expect(GLUED.length).toBeGreaterThanOrEqual(80)
  expect(ZSH.length).toBeGreaterThanOrEqual(20)
  expect(MENTIONS.length).toBeGreaterThanOrEqual(20)
  for (const l of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'])
    expect(
      LIMITS.some((e) => e.limit === l),
      l
    ).toBe(true)
  // An ordinary command names no raw-only file and no path under .veilio.
  const named = ORDINARY.filter((c) =>
    /(?:^|[\s/'"=])(?:\.env|secrets\/|server\.pem|id_ed25519)|[/~]\.veilio\//.test(c)
  )
  expect(named).toEqual([])
})

test('R3: every ordinary command runs, with the default list', async () => {
  expect(await refused(ORDINARY, [])).toEqual([])
}, 120_000)

test('R3: every ordinary command runs, with secrets/** raw-only', async () => {
  expect(await refused(ORDINARY, ['secrets/**'])).toEqual([])
}, 120_000)

// Addendum 2, A12: text a program only prints, stores or searches for. These
// name raw-only files and Veilio's folder, which no ordinary entry may.
test('every mention runs, with the default list', async () => {
  expect(await refused(MENTIONS, [])).toEqual([])
}, 120_000)

test('every mention runs, with secrets/** raw-only', async () => {
  expect(await refused(MENTIONS, ['secrets/**'])).toEqual([])
}, 120_000)

test('R4: every attack command is refused', async () => {
  const ran: string[] = []
  const refusedNow = new Set(await refused(ATTACK, ['secrets/**']))
  for (const c of ATTACK) if (!refusedNow.has(JSON.stringify(c))) ran.push(JSON.stringify(c))
  expect(ran).toEqual([])
}, 120_000)

test('R4: every documented limit runs', async () => {
  const bash = LIMITS.filter((l) => !l.tool && !l.list).map((l) => l.command)
  const byDefault = LIMITS.filter((l) => l.list === 'default').map((l) => l.command)
  const powershell = LIMITS.filter((l) => l.tool === 'PowerShell').map((l) => l.command)
  expect([
    ...(await refused(bash, ['secrets/**'])),
    ...(await refused(byDefault, [])),
    ...(await refused(powershell, ['secrets/**'], 'PowerShell')),
  ]).toEqual([])
}, 120_000)
