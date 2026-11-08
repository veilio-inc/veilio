// Review round 1 item (b): a git command that only reads still runs a program
// the repository's own configuration names (an external diff, a textconv
// filter, a pager, a signature check, an fsmonitor or a hooks folder). The
// agent can write that configuration with a plain `git config` call, so no
// placeholder is restored into a git command while it is set. One real
// repository per case, with git's own `config --list` read as the plugin
// reads it.
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
import { Guard, type GuardIO } from '../../plugins/veilio-guard/lib/guard.ts'

let base: string
let root: string
let home: string

function git(...args: string[]): string {
  const env: NodeJS.ProcessEnv = { HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith('GIT_') && k !== 'HOME') env[k] = v
  return execFileSync('git', args, { cwd: root, env, encoding: 'utf8' })
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-git-config-')))
  root = join(base, 'proj')
  home = join(base, 'home')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, '.veilio'), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(root, 'src', 'pay.ts'), 'export class PaymentGateway {}\n')
  writeFileSync(
    join(root, '.veilio', 'map.json'),
    JSON.stringify({ version: 1, map: { __CLS__1: 'PaymentGateway' } })
  )
  writeFileSync(join(root, '.veilio', '.gitignore'), '*\n')
  git('init', '-q')
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

async function guard(): Promise<Guard> {
  const io: GuardIO = {
    read: async (p) => readFileSync(p, 'utf8'),
    write: async (p, t) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, t)
    },
    exists: async (p) => existsSync(p),
    realPath: async (p) => (existsSync(p) ? realpathSync(p) : undefined),
    list: async () => git('ls-files', '-z').split('\0').filter(Boolean),
    // As hooks/register.ts runs it.
    gitConfig: async (dir) => {
      try {
        return execFileSync('git', ['config', '--show-scope', '--includes', '--list', '-z'], {
          cwd: dir,
          env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
          encoding: 'utf8',
        })
      } catch {
        return null
      }
    },
  }
  const g = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await g.load(root, home)
  return g
}

const diff = { tool: 'Bash', command: 'git diff -- src/__CLS__1.ts' }

describe('a git command gets no real names back while the repository configuration runs a program', () => {
  it('restores into git diff in a plain repository', async () => {
    const out = await (await guard()).beforeTool(diff)
    expect(out).toEqual({ args: { ...diff, command: 'git diff -- src/PaymentGateway.ts' } })
  })

  for (const [key, value] of [
    ['diff.external', './x.sh'],
    ['diff.pay.textconv', './x.sh'],
    ['diff.pay.command', './x.sh'],
    ['filter.pay.clean', './x.sh'],
    ['filter.pay.process', './x.sh'],
    ['core.pager', './x.sh'],
    ['pager.diff', './x.sh'],
    ['gpg.program', './x.sh'],
    ['gpg.ssh.program', './x.sh'],
    ['core.fsmonitor', './x.sh'],
    ['core.hooksPath', 'hooks'],
  ])
    it(`refuses git diff when .git/config sets ${key}`, async () => {
      git('config', key, value)
      const out = await (await guard()).beforeTool(diff)
      expect('deny' in out && out.deny).toBe(
        `Veilio refused this call: this repository's git configuration sets ${key.toLowerCase()}, which runs a program of its own, so a git command gets no real names back. Run it without the placeholder, or ask the user to remove that setting.`
      )
    })

  it('refuses when the setting comes from a file .git/config includes', async () => {
    writeFileSync(join(root, 'extra.cfg'), '[core]\n\tpager = ./x.sh\n')
    git('config', 'include.path', '../extra.cfg')
    const out = await (await guard()).beforeTool(diff)
    expect('deny' in out && out.deny).toContain('sets core.pager')
  })

  it('refuses each git part of a chain, and not a chain without git', async () => {
    git('config', 'core.fsmonitor', './x.sh')
    const g = await guard()
    const chain = await g.beforeTool({ tool: 'Bash', command: 'cat src/__CLS__1.ts && git log' })
    expect('deny' in chain && chain.deny).toContain('sets core.fsmonitor')
    const plain = await g.beforeTool({ tool: 'Bash', command: 'cat src/__CLS__1.ts' })
    expect(plain).toEqual({ args: { tool: 'Bash', command: 'cat src/PaymentGateway.ts' } })
  })

  it('reads the configuration on every call: one set after the first call is refused', async () => {
    const g = await guard()
    expect('args' in (await g.beforeTool(diff))).toBe(true)
    git('config', 'diff.external', './x.sh')
    expect('deny' in (await g.beforeTool(diff))).toBe(true)
  })

  it("leaves the user's own global setting alone (a global core.pager is theirs)", async () => {
    writeFileSync(join(home, '.gitconfig'), '[core]\n\tpager = less\n')
    const out = await (await guard()).beforeTool(diff)
    expect('args' in out).toBe(true)
  })

  it('refuses when the configuration cannot be read', async () => {
    const g = await guard()
    ;(g as unknown as { io: GuardIO }).io.gitConfig = async () => null
    const out = await g.beforeTool(diff)
    expect('deny' in out && out.deny).toBe(
      "Veilio refused this call: Veilio could not read this repository's git configuration, so a git command gets no real names back. Run it without the placeholder, or ask the user to run it."
    )
  })
})
