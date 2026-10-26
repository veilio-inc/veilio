import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { resolveMapPath, saveMap } from '@veilio-inc/cli/store'
import { credentialPath, readCredential } from '@veilio-inc/cli/credential'
import { contextFromArgv } from '../src/index.js'
import { callTool, callToolAsync, type ToolContext } from '../src/tools.js'
import {
  namespaceSettled,
  primeNamespace,
  refreshNamespaceIfStale,
  resetNamespaceCache,
} from '../src/namespace.js'
import { FakeCloud, TEAMMATE, sealTeam, signIn } from '../../cli/tests/helpers/fake-cloud.js'
import { serveOverHttp } from '../../cli/tests/helpers/http-fake.js'

/**
 * `VEILIO_PROJECT` in the MCP server's environment (spec 052 FR-012a).
 *
 * The case it exists for: each repository's `.mcp.json` sets it through
 * `env`, so the agent working in repository A masks with A's project's names
 * and never B's - whatever `veilio projects use` stored for the sign-in they
 * share. Every map, status and project tool follows it, and so does the team
 * namespace the masking tools number from. A value naming no project makes
 * them errors naming it; the masking tools refuse rather than mask locally.
 */

let home: string
let cwd: string
let cloud: FakeCloud
let billingMap: string
let toolsMap: string

const ctxWith = (env: Record<string, string>): ToolContext => ({
  cwd,
  mapPath: null,
  home,
  destructive: false,
  env,
})

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'veilio-mcp-penv-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-penv-work-'))
  mkdirSync(join(cwd, '.git'))
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
  resetNamespaceCache()
  signIn(home, { team: true, project: 'p-billing' })
  billingMap = cloud.add({
    scope: 'team',
    owner: TEAMMATE,
    name: 'billing-names',
    project: 'p-billing',
    map_data: await sealTeam({ __CLS__1: 'Alpha' }),
  }).id
  toolsMap = cloud.add({
    scope: 'team',
    owner: TEAMMATE,
    name: 'tools-names',
    project: 'p-tools',
    map_data: await sealTeam({ __CLS__5: 'Gamma' }),
  }).id
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetNamespaceCache()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const storePath = (): string => resolveMapPath(null, cwd)

function onlyTheListing(): void {
  expect(cloud.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/projects'])
  for (const r of cloud.requests) {
    expect(r.query.get('project')).toBeNull()
    expect(r.body?.project).toBeUndefined()
  }
}

describe('the server’s context carries its environment', () => {
  it('contextFromArgv keeps VEILIO_PROJECT for the tools', () => {
    expect(contextFromArgv([], { VEILIO_PROJECT: 'tools' }).env?.VEILIO_PROJECT).toBe('tools')
  })
})

describe('with VEILIO_PROJECT set in the server’s env', () => {
  const env = { VEILIO_PROJECT: 'tools' }

  it('maps_list lists that project’s team maps, and says where the choice came from', async () => {
    const r = await callToolAsync('maps_list', {}, ctxWith(env))
    expect(r.isError ?? false, r.text).toBe(false)
    expect(r.text).toContain(toolsMap)
    expect(r.text).not.toContain(billingMap)
    expect(r.text).toContain('Team maps of project tools (from VEILIO_PROJECT).')
    expect(cloud.requests.find((x) => x.path === '/api/maps')!.query.get('project')).toBe('p-tools')
  })

  it('without it, the same server context lists the stored project’s', async () => {
    const r = await callToolAsync('maps_list', {}, ctxWith({}))
    expect(r.text).toContain(billingMap)
    expect(r.text).not.toContain(toolsMap)
    expect(r.text).not.toContain('VEILIO_PROJECT')
  })

  it('team_status names the project and the variable', async () => {
    const r = await callToolAsync('team_status', {}, ctxWith(env))
    expect(r.isError ?? false, r.text).toBe(false)
    expect(r.text).toContain('Project: tools (p-tools) (from VEILIO_PROJECT)')
  })

  it('projects_list marks it, and says the override is in force', async () => {
    const r = await callToolAsync('projects_list', {}, ctxWith(env))
    expect(r.text).toMatch(/^\* p-tools {2}tools {2}\(in use, from VEILIO_PROJECT/m)
    expect(r.text).toMatch(/^ {2}p-billing /m)
    expect(r.text).toContain('VEILIO_PROJECT is "tools", so that project is in use here')
  })

  it('projects_use stores the choice, and warns the server’s variable overrides it', async () => {
    const r = await callToolAsync('projects_use', { project: 'p-billing' }, ctxWith(env))
    expect(r.isError ?? false, r.text).toBe(false)
    expect(readCredential(home)?.project).toBe('p-billing')
    expect(r.text).toContain(
      'WARNING: VEILIO_PROJECT is set ("tools") for this MCP server, and it overrides this choice'
    )
  })

  it('anonymize_text numbers from the variable’s project: Gamma is tools’ __CLS__5', async () => {
    await primeNamespace(home, { env })
    const r = callTool('anonymize_text', { text: 'export class Gamma {}' }, ctxWith(env))
    expect(r.isError ?? false, r.text).toBe(false)
    expect(r.text).toContain('__CLS__5')
    expect(r.text).toContain('Namespace: team')
  })

  it('a stored choice changed meanwhile does not unpin it: the namespace is kept', async () => {
    await primeNamespace(home, { env })
    // `veilio projects use tools` in a terminal, while this server runs.
    signIn(home, { team: true, project: 'p-tools' })
    expect(refreshNamespaceIfStale()).toBeNull()
    const r = callTool('anonymize_text', { text: 'export class Gamma {}' }, ctxWith(env))
    expect(r.text).toContain('__CLS__5')
  })
})

describe('a VEILIO_PROJECT naming no project: errors that name it', () => {
  const env = { VEILIO_PROJECT: 'payroll' }

  it('maps_list: an error naming the value and the variable; only the listing went out', async () => {
    const r = await callToolAsync('maps_list', {}, ctxWith(env))
    expect(r.isError).toBe(true)
    expect(r.text).toContain(
      'VEILIO_PROJECT is "payroll", which is not a project your team works in'
    )
    onlyTheListing()
  })

  it('an ambiguous name: the same', async () => {
    cloud.projects.push({ id: 'p-tools-2', name: 'tools' })
    const r = await callToolAsync('team_status', {}, ctxWith({ VEILIO_PROJECT: 'tools' }))
    expect(r.isError).toBe(true)
    expect(r.text).toContain('VEILIO_PROJECT is "tools", and 2 projects are called that')
    onlyTheListing()
  })

  it('anonymize_text refuses - nothing masked from the local map, nothing stored', async () => {
    await primeNamespace(home, { env })
    onlyTheListing()
    const r = callTool('anonymize_text', { text: 'export class Gamma {}' }, ctxWith(env))
    expect(r.isError).toBe(true)
    expect(r.text).toContain('VEILIO_PROJECT is "payroll"')
    expect(r.text).not.toContain('__CLS__')
    expect(existsSync(storePath())).toBe(false)
  })

  it('restore_text refuses too', async () => {
    saveMap(storePath(), { __CLS__1: 'Alpha' }, { force: true })
    await primeNamespace(home, { env })
    const r = callTool('restore_text', { text: 'class __CLS__1 {}' }, ctxWith(env))
    expect(r.isError).toBe(true)
    expect(r.text).toContain('VEILIO_PROJECT is "payroll"')
    expect(r.text).not.toContain('Alpha')
  })
})

describe('two servers, one HOME, two repositories’ .mcp.json', () => {
  /** Start the built server with `env`, call maps_list once, return its text. */
  async function mapsListFrom(env: Record<string, string>): Promise<string> {
    const bin = resolve(import.meta.dirname, '..', 'dist', 'index.js')
    const child = spawn(process.execPath, [bin, '--root', cwd], {
      env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString()))
    child.stdin.write(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"maps_list","arguments":{}}}\n'
    )
    await vi.waitFor(() => expect(out).toContain('"id":1'), { timeout: 15_000 })
    child.stdin.end()
    await new Promise((r) => child.on('close', r))
    const reply = JSON.parse(out.split('\n').find((l) => l.includes('"id":1'))!) as {
      result: { content: { text: string }[] }
    }
    return reply.result.content.map((c) => c.text).join('\n')
  }

  it('each lists its own project’s team maps, at the same time', async () => {
    vi.unstubAllGlobals()
    const { url, close } = await serveOverHttp(cloud)
    try {
      signIn(home, { team: true, project: 'p-billing', instance: url })
      const before = readFileSync(credentialPath(home), 'utf8')
      const [a, b] = await Promise.all([
        mapsListFrom({ VEILIO_PROJECT: 'tools' }),
        mapsListFrom({ VEILIO_PROJECT: 'billing' }),
      ])
      expect(a).toContain(toolsMap)
      expect(a).not.toContain(billingMap)
      expect(a).toContain('project tools (from VEILIO_PROJECT)')
      expect(b).toContain(billingMap)
      expect(b).not.toContain(toolsMap)
      expect(b).toContain('project billing (from VEILIO_PROJECT)')
      expect(readFileSync(credentialPath(home), 'utf8')).toBe(before)
    } finally {
      await close()
    }
  }, 30_000)
})

// The namespace settles in the background in some cases above; nothing may
// still be loading when the next test resets the cache.
afterEach(async () => {
  await namespaceSettled()
})
