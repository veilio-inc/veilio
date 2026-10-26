// Every Veilio client reads every file strictly (spec 013 R16). The engine
// can report, rather than redact, a weak value in a secret position in a
// test, fixture or example file, but only when its caller names the file, and
// no shipped client does: a copy of `.env` in `tests/` cannot be told from a
// committed fixture safely enough, and five ways to launder one were found.
// One real checkout, a committed tests/ file, and both the CLI and the guard
// redact the weak password in it. The MCP server's half is in
// packages/mcp/tests/strict-test-files.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../../packages/cli/src/index.ts'
import type { Io } from '../../packages/cli/src/commands.ts'
import { Guard, type GuardIO } from '../../plugins/veilio-guard/lib/guard.ts'

;(globalThis as { __veilioStrictMaps?: boolean }).__veilioStrictMaps = true

const WEAK = 'Summer24'
const TEST_FILE = `export const env = { PGPASSWORD: '${WEAK}' }\n`

let base: string
let root: string

function git(...args: string[]): void {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v
  execFileSync('git', args, { cwd: root, env, stdio: 'ignore' })
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-clients-strict-')))
  root = join(base, 'proj')
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(join(root, 'tests', 'x.test.ts'), TEST_FILE)
  git('init', '-q')
  git('config', 'user.email', 'dev@example.com')
  git('config', 'user.name', 'Dev')
  git('config', 'commit.gpgsign', 'false')
  git('add', '--', 'tests/x.test.ts')
  git('commit', '-q', '-m', 'init')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('a weak password in a committed, unmodified tests/ file', () => {
  it('the CLI redacts it', async () => {
    let out = ''
    const io: Io = {
      cwd: root,
      home: join(base, 'home'),
      stdin: async () => '',
      stdout: (t) => (out += t),
      stderr: () => undefined,
    }
    expect(await main(['scrub', 'tests/x.test.ts'], io)).toBe(0)
    expect(out).not.toContain(WEAK)
    expect(out).toContain('__REDACTED_')
  })

  it("the guard's Read of it redacts it", async () => {
    const io: GuardIO = {
      read: async (p) => readFileSync(p, 'utf8'),
      write: async (p, t) => {
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, t)
      },
      exists: async (p) => existsSync(p),
      realPath: async (p) => (existsSync(p) ? realpathSync(p) : undefined),
    }
    const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
    await guard.load(root)
    const path = join(root, 'tests', 'x.test.ts')
    const result = {
      type: 'text',
      file: { filePath: path, content: TEST_FILE, numLines: 1, startLine: 1, totalLines: 1 },
    }
    const out = await guard.afterTool('Read', { tool: 'Read', file_path: path }, { result })
    expect('deny' in out).toBe(false)
    expect(JSON.stringify(out)).not.toContain(WEAK)
    expect(JSON.stringify(out)).toContain('__REDACTED_')
  })
})
