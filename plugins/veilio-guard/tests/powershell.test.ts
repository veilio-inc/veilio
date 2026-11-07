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
