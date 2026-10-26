// The MCP server reads every file strictly (spec 013 R16): a weak password in
// a secret position in a committed tests/ file is redacted, as by the CLI and
// the guard (tests/guard/clients-strict.test.ts at the repository root).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { callTool, type ToolContext } from '../src/tools.js'
import { isolateHome } from './helpers/isolated-home.js'

isolateHome()

const WEAK = 'Summer24'
const TEST_FILE = `export const env = { PGPASSWORD: '${WEAK}' }\n`

let base: string
let ctx: ToolContext

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-mcp-strict-')))
  const root = join(base, 'proj')
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(join(root, 'tests', 'x.test.ts'), TEST_FILE)
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'dev@example.com')
  git('config', 'user.name', 'Dev')
  git('config', 'commit.gpgsign', 'false')
  git('add', '--', 'tests/x.test.ts')
  git('commit', '-q', '-m', 'init')
  ctx = { cwd: root, mapPath: join(base, 'map.json'), home: join(base, 'home') }
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('a weak password in a committed, unmodified tests/ file', () => {
  it('anonymize_file redacts it', () => {
    const out = callTool('anonymize_file', { path: 'tests/x.test.ts' }, ctx).text
    expect(out).not.toContain(WEAK)
    expect(out).toContain('__REDACTED_')
  })

  it('scan_secrets reads it as a credential, not a test fixture', () => {
    const out = callTool('scan_secrets', { path: 'tests/x.test.ts' }, ctx).text
    expect(out).toContain('Password')
    expect(out).not.toContain('reported only')
  })
})
