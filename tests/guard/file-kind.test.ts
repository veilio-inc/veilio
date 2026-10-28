// Engine spec 013 R19: the guard passes the read file's kind (fileKindOf),
// never its path, so the environment-style credential rules reach a Read of a
// compose file or a script while the test-file relaxation stays off.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Guard, type GuardIO } from '../../plugins/veilio-guard/lib/guard.ts'
;(globalThis as { __veilioStrictMaps?: boolean }).__veilioStrictMaps = true

const FILES: Record<string, string> = {
  'compose.yml': 'services:\n  db:\n    environment:\n      API_TOKEN: Tr0ub4dor zebra91\n',
  // No other file named: the guard withholds a result naming a file it cannot find.
  'deploy.sh': 'export STRIPE_SECRET_KEY=Tr0ub4dorZebra91\necho deployed\n',
  'config/app.env': 'DB_PASSWORD=Tr0ub4dor zebra91\n',
}

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-guard-kind-')))
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), text)
  }
  // A real checkout: the guard lists the project with git to know its files.
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'dev@example.com')
  git('config', 'user.name', 'Dev')
  git('config', 'commit.gpgsign', 'false')
  git('add', '--', ...Object.keys(FILES))
  git('commit', '-q', '-m', 'init')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const io: GuardIO = {
  read: async (p) => readFileSync(p, 'utf8'),
  write: async (p, t) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, t)
  },
  exists: async (p) => existsSync(p),
  realPath: async (p) => (existsSync(p) ? realpathSync(p) : undefined),
}

describe("the guard's Read: the file kind reaches the engine", () => {
  for (const name of Object.keys(FILES)) {
    it(`${name}: the value never reaches the model, whole or in pieces`, async () => {
      const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
      await guard.load(root)
      const path = join(root, name)
      const content = FILES[name]
      const result = {
        type: 'text',
        file: { filePath: path, content, numLines: 3, startLine: 1, totalLines: 3 },
      }
      const out = JSON.stringify(
        await guard.afterTool('Read', { tool: 'Read', file_path: path }, { result })
      )
      expect(out).not.toMatch(/Tr0ub4dor|zebra91|Zebra91/)
      expect(out).toContain('__REDACTED_')
    })
  }
})

describe("the guard's Edit: patch lines are read as the lines they hold", () => {
  it('a compose file edit: neither value reaches the model, in the strings or the patch', async () => {
    const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
    await guard.load(root)
    const path = join(root, 'compose.yml')
    const before = '      API_TOKEN: Summer2024\n'
    const after = '      API_TOKEN: Autumn2025\n'
    const result = {
      filePath: path,
      oldString: before,
      newString: after,
      originalFile: `services:\n  db:\n    environment:\n${before}`,
      structuredPatch: [
        {
          oldStart: 4,
          oldLines: 1,
          newStart: 4,
          newLines: 1,
          lines: [`-${before.trimEnd()}`, `+${after.trimEnd()}`],
        },
      ],
      userModified: false,
      replaceAll: false,
    }
    const out = JSON.stringify(
      await guard.afterTool(
        'Edit',
        { tool: 'Edit', file_path: path, old_string: before, new_string: after },
        { result }
      )
    )
    expect(out).not.toMatch(/Summer2024|Autumn2025/)
  })
})
