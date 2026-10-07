// The PowerShell tool is Claude Code's shell on Windows. It had no row, so it
// fell to the branch for unknown tools: nothing restored, and a raw-only file
// refused only when an argument was a bare path. `Get-Content .env.local` has
// a space, so it ran, and the model read the file (Windows test report F2).
// A placeholder in its command reached the file as written (F3). It gets the
// checks Bash gets.
import { expect, test } from 'claude-code/testing'
import { CANARY, mapFile, project, ROOT } from './helpers.ts'

const SECRET = 'DB_PASSWORD=haslo123'
const FILES = {
  [`${ROOT}/.env`]: `${SECRET}\n`,
  [`${ROOT}/.env.local`]: `${SECRET}\n`,
  [`${ROOT}/.veilio/map.json`]: mapFile({ __CLS__1: CANARY }),
}

function powershell(on: any) {
  project(on, FILES)
  const seen: any[] = []
  on('tool.call', (_: any, e: any) => {
    seen.push(e)
    return { result: { stdout: SECRET, stderr: '' } }
  })
  return seen
}

test('PowerShell: a command that reads .env.local is refused before it runs', async ($, on) => {
  // The command from the Windows report, which ran and showed the password.
  const seen = powershell(on)
  const out: any = await $.tool.call({
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
    const out: any = await $.tool.call({ tool: 'PowerShell', command, description: 'x' })
    expect(seen.length).toBe(0)
    expect(out.deny).toContain('away from the model')
    expect(JSON.stringify(out)).not.toContain('haslo123')
  })
}

test('PowerShell: a known placeholder is restored before the command runs', async ($, on) => {
  const seen = powershell(on)
  const out: any = await $.tool.call({
    tool: 'PowerShell',
    command: 'Add-Content -Path notes.md -Value "See also __CLS__1"',
    description: 'note',
  })
  expect(out.deny).toBeUndefined()
  expect(seen[0].command).toBe(`Add-Content -Path notes.md -Value "See also ${CANARY}"`)
})

test('PowerShell: a placeholder the map does not have is refused, so no file receives it', async ($, on) => {
  const seen = powershell(on)
  const out: any = await $.tool.call({
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
  const out: any = await $.tool.call({
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
  const out: any = await $.tool.call({
    tool: 'PowerShell',
    command: 'Get-Content src\\ledger.ts',
    description: 'read',
  })
  expect(out.deny).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain(CANARY)
  expect(JSON.stringify(out)).toContain('__CLS__1')
})
