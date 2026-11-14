// Spec 093 item 8 (the founder's ruling, 2026-11-13): VEILIO_MCP_RESTORE and
// VEILIO_MCP_DESTRUCTIVE are the person's switches. A repository's own
// `.mcp.json` can set a server's environment, so a switch that file names is
// ignored: a cloned project cannot turn restore_text or the destructive tools
// on. VEILIO_PROJECT from the same file keeps working.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { contextFromArgv } from '../src/index.js'
import { handleMessage } from '../src/server.js'
import { isolateHome } from './helpers/isolated-home.js'

const home = isolateHome()

const IGNORED =
  "veilio-mcp: this project's .mcp.json sets VEILIO_MCP_RESTORE / VEILIO_MCP_DESTRUCTIVE. Settings from a project file are ignored; set them in your own environment to use them."
const BOTH = { VEILIO_MCP_RESTORE: '1', VEILIO_MCP_DESTRUCTIVE: '1' }

let dir: string
let elsewhere: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'veilio-mcp-switch-'))
  elsewhere = mkdtempSync(join(tmpdir(), 'veilio-mcp-switch-other-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(elsewhere, { recursive: true, force: true })
})

const projectFile = (servers: unknown, where = dir): void =>
  writeFileSync(join(where, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
const server = (env: unknown) => ({ command: 'npx', args: ['-y', '@veilio-inc/mcp'], env })

const names = (ctx: ReturnType<typeof contextFromArgv>) => {
  const r = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, ctx) as {
    result: { tools: { name: string }[] }
  }
  return r.result.tools.map((t) => t.name)
}

describe('a switch the project file sets is ignored', () => {
  it.each([
    ['VEILIO_MCP_RESTORE', { veilio: server({ VEILIO_MCP_RESTORE: '1' }) }],
    ['VEILIO_MCP_DESTRUCTIVE', { veilio: server({ VEILIO_MCP_DESTRUCTIVE: '1' }) }],
    [
      'either, under a server of another name',
      { docs: server({}), 'my-tools': server({ VEILIO_MCP_RESTORE: '1' }) },
    ],
    ['either, whatever its value', { veilio: server({ VEILIO_MCP_DESTRUCTIVE: '' }) }],
  ])('%s: both are off, it is said, and restore_text is not listed', (_, servers) => {
    projectFile(servers)
    const ctx = contextFromArgv([], BOTH, dir)
    expect(ctx.restoreText).toBe(false)
    expect(ctx.destructive).toBe(false)
    expect(ctx.switchesIgnored).toBe(IGNORED)
    expect(names(ctx)).not.toContain('restore_text')
    expect(names(ctx)).toContain('anonymize_file')
  })

  // Review round 1: the name anywhere in any project configuration file a
  // client reads, in this folder or one above it.
  const write = (where: string, name: string, text: string): void => {
    mkdirSync(join(where, name, '..'), { recursive: true })
    writeFileSync(join(where, name), text)
  }
  it.each([
    [
      'an env wrapper command',
      '.mcp.json',
      '{"mcpServers":{"veilio":{"command":"env","args":["VEILIO_MCP_RESTORE=1","npx","-y","@veilio-inc/mcp"]}}}',
    ],
    [
      'Cursor’s file',
      '.cursor/mcp.json',
      '{"mcpServers":{"v":{"env":{"VEILIO_MCP_RESTORE":"1"}}}}',
    ],
    [
      'VS Code’s file, under `servers`',
      '.vscode/mcp.json',
      '{"servers":{"v":{"env":{"VEILIO_MCP_DESTRUCTIVE":"1"}}}}',
    ],
    [
      'Claude Code’s project settings',
      '.claude/settings.json',
      '{"env":{"VEILIO_MCP_RESTORE":"1"}}',
    ],
    [
      'Claude Code’s local project settings',
      '.claude/settings.local.json',
      '{"env":{"VEILIO_MCP_DESTRUCTIVE":"1"}}',
    ],
    ['a lower-case key', '.mcp.json', '{"mcpServers":{"v":{"env":{"veilio_mcp_restore":"1"}}}}'],
    ['a file that is not JSON', '.mcp.json', 'VEILIO_MCP_DESTRUCTIVE=1 {'],
  ])('%s: both are off, and it is said', (_, name, text) => {
    write(dir, name, text)
    const ctx = contextFromArgv([], BOTH, dir)
    expect([ctx.restoreText, ctx.destructive]).toEqual([false, false])
    expect(ctx.switchesIgnored).toBe(IGNORED)
  })

  it('a file in a folder above, up to the one that holds .git', () => {
    write(dir, '.mcp.json', '{"mcpServers":{"v":{"env":{"VEILIO_MCP_RESTORE":"1"}}}}')
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, 'packages', 'api'), { recursive: true })
    const ctx = contextFromArgv([], BOTH, join(dir, 'packages', 'api'))
    expect([ctx.restoreText, ctx.destructive]).toEqual([false, false])
    expect(ctx.switchesIgnored).toBe(IGNORED)
  })

  it('a file too large to read whole counts as setting them', () => {
    write(dir, '.mcp.json', ' '.repeat(1024 * 1024 + 1))
    expect(contextFromArgv([], BOTH, dir).switchesIgnored).toBe(IGNORED)
  })

  it('the file is found in the --root folder too', () => {
    projectFile({ veilio: server({ VEILIO_MCP_RESTORE: '1' }) })
    const ctx = contextFromArgv(['--root', dir], BOTH, elsewhere)
    expect([ctx.restoreText, ctx.destructive]).toEqual([false, false])
    expect(ctx.switchesIgnored).toBe(IGNORED)
  })
})

describe('otherwise the environment decides, as before', () => {
  const decided = () => {
    const ctx = contextFromArgv([], BOTH, dir)
    expect(ctx.restoreText).toBe(true)
    expect(ctx.destructive).toBe(true)
    expect(ctx.switchesIgnored).toBeUndefined()
    expect(names(ctx)).toContain('restore_text')
    return ctx
  }

  it('no project file', () => {
    decided()
  })

  it('a project file that sets only VEILIO_PROJECT, which keeps working', () => {
    projectFile({ veilio: server({ VEILIO_PROJECT: 'payments' }) })
    const ctx = contextFromArgv([], { ...BOTH, VEILIO_PROJECT: 'payments' }, dir)
    expect([ctx.restoreText, ctx.destructive]).toEqual([true, true])
    expect(ctx.switchesIgnored).toBeUndefined()
    expect(ctx.env?.VEILIO_PROJECT).toBe('payments')
  })

  it.each([
    ['not JSON', '{"mcpServers":'],
    ['a list', '[]'],
    ['no servers', '{}'],
    ['servers that are not a record', '{"mcpServers":3}'],
    ['a server that is not a record', '{"mcpServers":{"veilio":null}}'],
  ])('a project file that is %s', (_, text) => {
    writeFileSync(join(dir, '.mcp.json'), text)
    decided()
  })

  it('a project file that cannot be read', () => {
    mkdirSync(join(dir, '.mcp.json'))
    decided()
  })

  it('a file above the folder that holds .git is another project’s, and is not read', () => {
    writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{"v":{"env":{"VEILIO_MCP_RESTORE":"1"}}}}')
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true })
    mkdirSync(join(dir, 'repo', 'api'))
    const ctx = contextFromArgv([], BOTH, join(dir, 'repo', 'api'))
    expect([ctx.restoreText, ctx.destructive]).toEqual([true, true])
  })

  it('your own user-level files in the home folder are yours: the walk stops below it', () => {
    mkdirSync(join(home(), '.cursor'), { recursive: true })
    writeFileSync(
      join(home(), '.cursor', 'mcp.json'),
      '{"mcpServers":{"v":{"env":{"VEILIO_MCP_RESTORE":"1"}}}}'
    )
    mkdirSync(join(home(), 'work'), { recursive: true })
    const ctx = contextFromArgv([], BOTH, join(home(), 'work'))
    expect([ctx.restoreText, ctx.destructive]).toEqual([true, true])
    expect(ctx.switchesIgnored).toBeUndefined()
  })

  it('with the switches unset, nothing is said about a file that sets none', () => {
    projectFile({ veilio: server({}) })
    const ctx = contextFromArgv([], {}, dir)
    expect([ctx.restoreText, ctx.destructive]).toEqual([false, false])
    expect(ctx.switchesIgnored).toBeUndefined()
  })
})

// stdout is the protocol stream: the line goes to stderr and nowhere else.
describe('the server, started in such a project', () => {
  const DIST = resolve(import.meta.dirname, '..', 'dist', 'index.js')
  const FRAMES =
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n') + '\n'
  const start = () =>
    spawnSync(process.execPath, [DIST], {
      cwd: dir,
      input: FRAMES,
      encoding: 'utf8',
      timeout: 15_000,
      // An empty home: no stored sign-in, so startup never reaches the network.
      env: { ...process.env, ...BOTH, HOME: elsewhere, USERPROFILE: elsewhere },
    })

  it('says so on stderr only, and does not list restore_text', () => {
    projectFile({ veilio: server({ VEILIO_MCP_RESTORE: '1' }) })
    const r = start()
    expect(r.stderr).toContain(`${IGNORED}\n`)
    expect(r.stderr).not.toContain('restore_text is on')
    expect(r.stdout).not.toContain('Settings from a project file')
    expect(r.stdout).toContain('anonymize_file')
    expect(r.stdout).not.toContain('restore_text')
  })

  it('without the file it starts as before, restore_text listed', () => {
    const r = start()
    expect(r.stderr).not.toContain('Settings from a project file')
    expect(r.stdout).toContain('restore_text')
  })
})
