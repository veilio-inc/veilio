import { expect, test } from 'vitest'
import { ATTACK, GLUED, LIMITS, MENTIONS, ORDINARY, ZSH } from './fixtures/reading-corpora.ts'
import { Guard, type GuardIO } from '../../plugins/veilio-guard/lib/guard.ts'
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

// Addendum 3 (contract §8.1, FR-010): a PowerShell command the guard cannot
// read and refuses is refused in the words for a command Veilio cannot read;
// a cd refusal keeps its own.
test('an unreadable PowerShell command is refused as one Veilio cannot read', async () => {
  const UNREADABLE = 'as a shell command, so it cannot tell whether it names a file'
  const guard = await guardAt(fixture, ['secrets/**'])
  for (const command of [
    'Write-Output "a`tb',
    '$a = @{Path = "x"}; Set-Location @a',
    '$h = @{ a = 1 }; & $s',
  ]) {
    const v = await verdict(guard, command, 'PowerShell')
    expect(v.text, command).toContain(UNREADABLE)
    expect(v.text, command).not.toContain('takes the shell')
  }
  // Read, and refused by a cd rule: the cd text.
  const cd = await verdict(guard, 'Set-Location -Foo ~\\.aws', 'PowerShell')
  expect(cd.text).toContain('takes the shell (a parameter Veilio cannot read)')
  const code = await verdict(guard, "Invoke-Expression 'Get-Content x'", 'PowerShell')
  expect(code.text).toContain('takes the shell (code run from text)')
  // Limit L8: unreadable, names nothing that moves the shell or runs text.
  expect((await verdict(guard, 'Get-Content "notes.txt', 'PowerShell')).verdict).toBe('allowed')
})

// Addendum 3 (report §2b): while `/veilio on` reads the settings again, a
// call already past the hook's state check is judged with the project's
// list, not with the built-in patterns alone.
test('a call in flight while /veilio on re-reads the settings is judged with the project list', async () => {
  const config = `${fixture.proj}/.veilio/guard.json`
  const files: Record<string, string> = {
    ...fixture.files,
    [config]: '{"rawOnly":["secrets/**"]}',
    [`${fixture.proj}/.git/HEAD`]: 'ref: refs/heads/main\n',
  }
  let gate: Promise<void> | null = null
  let reached = () => {}
  const io: GuardIO = {
    read: async (p) => {
      if (files[p] === undefined) throw new Error(`ENOENT: ${p}`)
      return files[p]
    },
    write: async () => {},
    exists: async (p) => {
      if (p === config && gate) {
        reached()
        await gate
      }
      return p in files || Object.keys(files).some((x) => x.startsWith(`${p}/`))
    },
    realPath: async (p) => p,
    isFile: async (p) => p in files,
    fileSize: async (p) => files[p]?.length,
  }
  const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await guard.load(fixture.proj, fixture.home)
  expect((await verdict(guard, 'cat secrets/customers.csv')).verdict).toBe('refused')
  let open = () => {}
  gate = new Promise((r) => (open = r))
  const atGate = new Promise<void>((r) => (reached = r))
  const switching = guard.setEnabled(true)
  await atGate
  // The settings are being read: the list a call sees is still the whole one.
  const during = await verdict(guard, 'cat secrets/customers.csv')
  open()
  await switching
  expect(during.verdict).toBe('refused')
  expect(guard.state).toBe('on')
  expect((await verdict(guard, 'cat secrets/customers.csv')).verdict).toBe('refused')
  expect((await verdict(guard, 'cat src/index.ts')).verdict).toBe('allowed')
})
