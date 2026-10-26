import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { resolveMapPath, saveMap } from '@veilio-inc/cli/store'
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
 * How many requests an agent's work costs (spec 052, the staging journey of
 * 2026-10-26, which hit the maps rate limit at ~8 listings per command).
 *
 * The team namespace is read once per process and per project, and again only
 * after a team write made here or a change of project - never per tool call.
 * Each map tool lists at most once. And every request the BUILT server sends,
 * over real HTTP, names it: `X-Veilio-Client: mcp`, `User-Agent:
 * veilio-mcp/<version>` (tracker d12).
 */

const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

let home: string
let cwd: string
let cloud: FakeCloud
let ctx: ToolContext

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'veilio-mcp-budget-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-budget-work-'))
  mkdirSync(join(cwd, '.git'))
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
  resetNamespaceCache()
  ctx = { cwd, mapPath: null, home }
  signIn(home, { team: true, pmk: true })
  cloud.add({ scope: 'team', name: 'shared', map_data: await sealTeam({ __CLS__1: 'Ledger' }) })
  cloud.add({ scope: 'team', owner: TEAMMATE, map_data: await sealTeam({ __CLS__7: 'Router' }) })
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetNamespaceCache()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const paths = (): string[] => cloud.requests.map((r) => `${r.method} ${r.path}`)

describe('the team namespace is read once, not per call', () => {
  it('twenty anonymize calls after start: two requests in all', async () => {
    await primeNamespace(home)
    for (let i = 0; i < 20; i++)
      callTool('anonymize_text', { text: `export class Thing${i} {}` }, ctx)
    expect(paths()).toEqual(['GET /api/maps', 'GET /api/maps/team-envelopes'])
  })

  it('with VEILIO_PROJECT set: twenty anonymize calls inside 30 s cost one projects request in all', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    try {
      const env = { VEILIO_PROJECT: 'tools' }
      const pinned = { ...ctx, env }
      await primeNamespace(home, { env })
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(1_000)
        await callToolAsync('anonymize_text', { text: `export class Thing${i} {}` }, pinned)
      }
      expect(paths().filter((p) => p === 'GET /api/projects')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('with VEILIO_PROJECT naming nothing: the refusal is asked again once per 30 s, by one path', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date'] })
    try {
      const env = { VEILIO_PROJECT: 'payroll' }
      const pinned = { ...ctx, env }
      await primeNamespace(home, { env })
      const calls = async (n: number): Promise<void> => {
        for (let i = 0; i < n; i++) {
          vi.advanceTimersByTime(1_000)
          const r = await callToolAsync('anonymize_text', { text: 'export class A {}' }, pinned)
          expect(r.isError).toBe(true)
        }
      }
      const listings = (): number => paths().filter((p) => p === 'GET /api/projects').length
      await calls(20)
      expect(listings()).toBe(1)
      vi.advanceTimersByTime(30_000)
      await calls(20)
      expect(listings()).toBe(2)
      // Nothing else was read: no team maps for a project that is not there.
      expect(paths().filter((p) => p === 'GET /api/maps')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a team write here reloads it once, then it is cached again', async () => {
    await primeNamespace(home)
    saveMap(resolveMapPath(null, cwd), { __CLS__2: 'Fresh' }, { force: true })
    cloud.requests = []
    const r = await callToolAsync('maps_create', { name: 'fresh', scope: 'team' }, ctx)
    expect(r.isError ?? false, r.text).toBe(false)
    expect(paths().length, paths().join('\n')).toBeLessThanOrEqual(3)
    cloud.requests = []
    expect(refreshNamespaceIfStale()).toBe('changed')
    await namespaceSettled()
    for (let i = 0; i < 10; i++) callTool('anonymize_text', { text: 'export class Fresh {}' }, ctx)
    expect(paths()).toEqual(['GET /api/maps', 'GET /api/maps/team-envelopes'])
  })

  it('maps_list: 1. maps_update of a team map: at most 3', async () => {
    expect((await callToolAsync('maps_list', {}, ctx)).isError ?? false).toBe(false)
    expect(paths()).toEqual(['GET /api/maps'])
    cloud.requests = []
    const id = cloud.maps.find((m) => m.name === 'shared')!.id
    saveMap(resolveMapPath(null, cwd), { __CLS__1: 'Ledger', __FN__2: 'settle' }, { force: true })
    const r = await callToolAsync('maps_update', { id }, ctx)
    expect(r.isError ?? false, r.text).toBe(false)
    expect(paths().length, paths().join('\n')).toBeLessThanOrEqual(3)
  })
})

describe('the built server, over real HTTP', () => {
  it('names itself on every request, the start-up namespace read included', async () => {
    vi.unstubAllGlobals()
    const { url, close } = await serveOverHttp(cloud)
    try {
      signIn(home, { team: true, pmk: true, instance: url })
      cloud.requests = []
      const bin = resolve(import.meta.dirname, '..', 'dist', 'index.js')
      const child = spawn(process.execPath, [bin, '--root', cwd], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
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
      expect(cloud.requests.length).toBeGreaterThanOrEqual(3)
      for (const req of cloud.requests) {
        expect(req.headers['x-veilio-client'], `${req.method} ${req.path}`).toBe('mcp')
        expect(req.headers['user-agent'], `${req.method} ${req.path}`).toBe(`veilio-mcp/${VERSION}`)
      }
    } finally {
      await close()
    }
  }, 30_000)
})
