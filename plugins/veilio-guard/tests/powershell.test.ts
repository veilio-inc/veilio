// The PowerShell tool is Claude Code's shell on Windows. It had no row, so it
// fell to the branch for unknown tools: nothing restored, and a raw-only file
// refused only when an argument was a bare path. `Get-Content .env.local` has
// a space, so it ran, and the model read the file (Windows test report F2).
// A placeholder in its command reached the file as written (F3). It gets the
// checks Bash gets.
import { expect, test } from 'claude-code/testing'
import { CANARY, mapFile, project, ROOT } from './helpers.ts'
import type { Fields } from './fixtures/recorded.ts'
import type { TestOn } from './kit.ts'

const SECRET = 'DB_PASSWORD=haslo123'
const FILES = {
  [`${ROOT}/.env`]: `${SECRET}\n`,
  [`${ROOT}/.env.local`]: `${SECRET}\n`,
  [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }),
}

function powershell(on: TestOn) {
  project(on, FILES)
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return { result: { stdout: SECRET, stderr: '' } }
  })
  return seen
}

test('PowerShell: a command that reads .env.local is refused before it runs', async ($, on) => {
  // The command from the Windows report, which ran and showed the password.
  const seen = powershell(on)
  const out = await $.tool.call({
    tool: 'PowerShell',
    command: 'Get-Content .env.local',
    description: 'x',
  })
  expect(seen.length).toBe(0)
  expect(out.deny).toContain('away from the model')
  expect(JSON.stringify(out)).not.toContain('haslo123')
})

for (const command of [
  'Get-Content -Path .\\.env',
  'Get-Content -Path:.env',
  "gc '.env.local' | Select-Object -First 1",
  'Get-Content notes.md,.env',
  'Invoke-Command {Get-Content .env}',
  'Get-Content .ENV',
  'gc .\\.env::$DATA',
]) {
  test(`PowerShell: ${command} is refused before it runs`, async ($, on) => {
    const seen = powershell(on)
    const out = await $.tool.call({ tool: 'PowerShell', command, description: 'x' })
    expect(seen.length).toBe(0)
    expect(out.deny).toContain('away from the model')
    expect(JSON.stringify(out)).not.toContain('haslo123')
  })
}

// Spec 078 R1: PowerShell has no read-or-test list yet, so a known placeholder
// is never put back into its commands (before, it was restored).
test('PowerShell: a known placeholder is refused, nothing restored', async ($, on) => {
  const seen = powershell(on)
  const out = await $.tool.call({
    tool: 'PowerShell',
    command: 'Add-Content -Path notes.md -Value "See also __CLS__1"',
    description: 'note',
  })
  expect(seen.length).toBe(0)
  expect(out.deny).toBe(
    'Veilio refused this call: PowerShell commands get no real names back yet. Use the Read, Edit, Write or Grep tool.'
  )
  expect(JSON.stringify(out)).not.toContain(CANARY)
})

test('PowerShell: a read gets no real names back either', async ($, on) => {
  const seen = powershell(on)
  const out = await $.tool.call({
    tool: 'PowerShell',
    command: 'Get-Content src/__CLS__1.ts',
    description: 'x',
  })
  expect(seen.length).toBe(0)
  expect(out.deny).toContain('PowerShell commands get no real names back yet')
})

test('PowerShell: a placeholder the map does not have is refused, so no file receives it', async ($, on) => {
  const seen = powershell(on)
  const out = await $.tool.call({
    tool: 'PowerShell',
    command: 'Set-Content -Path notes.md -Value "__FN__9"',
    description: 'write',
  })
  expect(seen.length).toBe(0)
  expect(out.deny).toContain('__FN__9')
  expect(out.deny).toContain('Edit')
})

test('PowerShell: a redaction token is refused, so the real credential is not overwritten', async ($, on) => {
  const seen = powershell(on)
  const out = await $.tool.call({
    tool: 'PowerShell',
    command: `'key = "__REDACTED_STRIPE_KEY_1__"' | Out-File src\\config.ts`,
    description: 'write',
  })
  expect(seen.length).toBe(0)
  expect(out.deny).toContain('__REDACTED_STRIPE_KEY_1__')
})

test('PowerShell: an ordinary command runs, and its output is masked', async ($, on) => {
  project(on, FILES)
  on('tool.call', () => ({ result: { stdout: `class ${CANARY} {}`, stderr: '' } }))
  const out = await $.tool.call({
    tool: 'PowerShell',
    command: 'Get-Content src\\ledger.ts',
    description: 'read',
  })
  expect(out.deny).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain(CANARY)
  expect(JSON.stringify(out)).toContain('__CLS__1')
})

// ── spec 086 US5: PowerShell's location cmdlets, read with its own quoting ──
const HOME = '/home/dev'
const A1 = (t: string) =>
  `Veilio keeps \`${t}\` away from the model, and a cd there would let a later command read it. Name the files you need by their full path, or ask the user.`
const A2 = (w: string) =>
  `Veilio keeps ${w} away from the model. Ask the user for what you need from it.`
const N1 = (t: string, form: string) =>
  `Veilio refused this call: Veilio cannot tell where \`${t}\` takes the shell (${form}), so a later command could read a file Veilio keeps away from the model. Use cd with a plain path, or name the files by their full path.`
const PS_TREE = {
  [`${HOME}/.aws/credentials`]: 'x\n',
  [`${HOME}/.kube/config`]: 'x\n',
  [`${ROOT}/.env`]: `${SECRET}\n`,
  [`${ROOT}/notes`]: 'plain\n',
  [`${ROOT}/sub/notes`]: '',
  [`${ROOT}/src/a.ts`]: '',
}
async function ps(
  $: Parameters<Parameters<typeof test>[1]>[0],
  on: TestOn,
  command: string
): Promise<string | undefined> {
  project(on, PS_TREE, { home: HOME, links: { [`${ROOT}/sub/notes`]: `${ROOT}/.env` } })
  on('tool.call', () => ({ result: { stdout: '', stderr: '' } }))
  return (await $.tool.call({ tool: 'PowerShell', command, description: 'x' })).deny
}

// research.md R4, the PowerShell forms; each refused with its target as written.
for (const [command, expected] of [
  ['Set-Location C:\\Users\\dev\\.aws; Get-Content credentials', A1('C:\\Users\\dev\\.aws')],
  ['sl ~\\.kube; gc config', A1('~\\.kube')],
  ['Push-Location ~\\.aws; gc credentials', A1('~\\.aws')],
  ['Write-Output $(Set-Location ~\\.kube; gc config)', A1('~\\.kube')],
  ['Microsoft.PowerShell.Management\\Set-Location ~\\.aws; gc credentials', A1('~\\.aws')],
  ['c`d ~\\.kube', A1('~\\.kube')],
  ['SET-LOCATION ~/.kube', A1('~/.kube')],
  ['Set-Location -Path ~\\.kube', A1('~\\.kube')],
  ['Set-Location -LiteralPath:~\\.aws', A1('~\\.aws')],
  // Only one plain path is followed (the allow-list): a variable is refused,
  // here after 078's floor, which reads `.aws` in the text.
  ['cd $env:USERPROFILE\\.aws', A1('$env:USERPROFILE\\.aws')],
  ['cd $env:USERPROFILE\\src', N1('$env:USERPROFILE\\src', 'a variable')],
  ['cd $HOME\\.aws', A1('$HOME\\.aws')],
  ['cd $HOME', N1('$HOME', 'a variable')],
  // The review of the PowerShell path: each form refused.
  ['& $cmd ~\\.aws', N1('$cmd', 'a call operator')],
  ["& 'Set-Location' ~\\.aws", N1("'Set-Location'", 'a call operator')],
  ['. Set-Location src', N1('Set-Location', 'a call operator')],
  ['Set-Location @a', N1('@a', 'splatting')],
  [
    '$a = @{Path = "x"}; Set-Location @a',
    N1('$a = @{Path = "x"}; Set-Location @a', 'a command Veilio cannot read'),
  ],
  [
    'Set-Location Microsoft.PowerShell.Core\\FileSystem::C:\\Users\\dev\\.aws',
    N1('Microsoft.PowerShell.Core\\FileSystem::C:\\Users\\dev\\.aws', 'a provider or network path'),
  ],
  ['Set-Location \\\\server\\share', N1('\\\\server\\share', 'a provider or network path')],
  ['Set-Location //server/share', N1('//server/share', 'a provider or network path')],
  ['Set-Location -Foo ~\\.aws', N1('-Foo', 'a parameter Veilio cannot read')],
  ['Set-Location -P ~\\.aws', N1('-P', 'a parameter Veilio cannot read')],
  ['Set-Location -Pa src', N1('-Pa', 'a parameter Veilio cannot read')],
  ['Set-Location -StackName s src', N1('-StackName', 'a parameter Veilio cannot read')],
  ['Set-Location src ~\\.aws', N1('src ~\\.aws', 'more than one target')],
  ['Pop-Location src', N1('src', 'more than one target')],
  [
    'switch (Set-Location ~\\.aws) { default { 1 } }',
    N1('switch (Set-Location ~\\.aws) { default { 1 } }', 'a command Veilio cannot read'),
  ],
  [
    'foreach ($x in (Set-Location ~\\.aws)) { }',
    N1('foreach ($x in (Set-Location ~\\.aws)) { }', 'a command Veilio cannot read'),
  ],
  [
    'for ($i = 0; $i -lt 1; Set-Location ..) { }',
    N1('for ($i = 0; $i -lt 1; Set-Location ..) { }', 'a command Veilio cannot read'),
  ],
  [
    '$h = @{ a = (Set-Location ~\\.aws) }',
    N1('$h = @{ a = (Set-Location ~\\.aws) }', 'a command Veilio cannot read'),
  ],
  // 078's floor refuses a cd target with `*`, `?` or `[` first (FR-009)
  ['Set-Location ~\\.k*', A1('~.k*')],
  ['Set-Location -LiteralPath "src[1]"', A1('src[1]')],
  ['Set-Location -Path "x" ; Set-Location -Path "~/.k?be"', A1('~/.k?be')],
  ['Set-Location $p', N1('$p', 'a variable')],
  ['Get-ChildItem | ForEach-Object { Set-Location ~\\.aws }', A1('~\\.aws')],
  ['Set-Location sub; Get-Content notes', A2('notes')],
  ['Set-Location sub | Out-Null; Get-Content notes', A2('notes')],
  ['function f { Set-Location ~\\.aws }; f', N1('f', 'a shell function')],
  ['filter f { $_ }; ls | f', N1('f', 'a shell function')],
] as const)
  test(`086 PowerShell ${JSON.stringify(command)} is refused`, async ($, on) => {
    expect(await ps($, on, command)).toBe(expected)
  })

// The ordinary forms (contracts/cd-verdicts.md), and the non-ASCII ones.
for (const command of [
  'Set-Location src; npm test',
  'Set-Location -Path src -ErrorAction Stop',
  'Set-Location "C:\\Program Files (x86)\\App"',
  'Push-Location src; npm test; Pop-Location',
  'Set-Location έγγραφα',
  'Set-Location "Wnioski\\źródła"; ls',
  'Push-Location src > $null',
  'Set-Location src -ErrorVariable err',
  '$x = 1; Set-Location src',
  'Set-Location sub && Set-Location .. && Get-Content notes',
  'Set-Location -Path src',
  'Set-Location -Pat src',
  'Set-Location src -PassThru',
  // a construct the reader does not model, with no location command: as on main
  'switch ($x) { 1 { "a" } }',
  'foreach ($f in Get-ChildItem) { $f.Name }',
])
  test(`086 PowerShell ${JSON.stringify(command)} runs`, async ($, on) => {
    expect(await ps($, on, command)).toBeUndefined()
  })
