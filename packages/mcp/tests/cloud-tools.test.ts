import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '@veilio-inc/cli'
import { resolveMapPath, saveMap, loadMap } from '@veilio-inc/cli/store'
import { readCredential } from '@veilio-inc/cli/credential'
import { FrameReader, respond, type JsonRpcResponse } from '../src/server.js'
import { CLOUD_TOOLS, callTool, callToolAsync, listTools, type ToolContext } from '../src/tools.js'
import {
  getNamespace,
  namespaceSettled,
  primeNamespace,
  refreshNamespaceIfStale,
  resetNamespaceCache,
} from '../src/namespace.js'
import {
  FakeCloud,
  PASSPHRASE,
  TEAMMATE,
  sealPersonal,
  sealTeam,
  signIn,
} from '../../cli/tests/helpers/fake-cloud.js'

/**
 * The MCP server's map, team and project tools (spec 052 US2, T021).
 *
 * Two claims. Signed out, the server is exactly the offline tool it always
 * was: five tools listed, nothing else (FR-023). Signed in, each new tool does
 * what the CLI command does for the same request against the SAME fake
 * server, refusing in the SAME words (FR-007, FR-019, SC-002) - checked by
 * running both and comparing, not by restating the expected text twice.
 */

const OFFLINE = [
  'anonymize_file',
  'anonymize_text',
  'restore_text',
  'scan_secrets',
  'symbol_map_summary',
]
const CLOUD = [
  'maps_list',
  'maps_pull',
  'maps_create',
  'maps_update',
  'maps_remove',
  'team_status',
  'projects_list',
  'projects_use',
]

let home: string
let cwd: string
let cloud: FakeCloud
let ctx: ToolContext

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-mcp-cloud-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-cloud-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
  ctx = { cwd, mapPath: null, home, destructive: false }
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const mapPath = (): string => resolveMapPath(null, cwd)
const local = (map: Record<string, string>): void => saveMap(mapPath(), map, { force: true })

async function listed(): Promise<string[]> {
  const res = (await respond(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ctx
  )) as JsonRpcResponse
  return (res.result as { tools: { name: string }[] }).tools.map((t) => t.name)
}

/** The CLI, against the same fake server and the same home and project. */
async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await main(argv, {
    cwd,
    home,
    stdin: async () => '',
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    password: async () => PASSPHRASE,
  })
  return { code, out, err }
}

/** A refusal's sentence, with each renderer's own prefix taken off and the
 *  terminal-only detail lines left out. */
function sentenceOf(text: string): string {
  return text.split('\n')[0]!.replace(/^(veilio|Veilio): /, '')
}

describe('signed out (FR-023)', () => {
  it('lists the five offline tools and nothing else', async () => {
    expect((await listed()).sort()).toEqual([...OFFLINE].sort())
    expect(
      listTools(ctx)
        .map((t) => t.name)
        .sort()
    ).toEqual([...OFFLINE].sort())
  })

  it.each(CLOUD)(
    '%s, called anyway, answers that it needs a sign-in, and sends nothing',
    async (name) => {
      const r = await callToolAsync(
        name,
        { id: 'map-1', name: 'x', scope: 'personal', project: 'p', confirmName: 'x' },
        ctx
      )
      expect(r.isError).toBe(true)
      expect(r.text).toBe('Veilio: not signed in. Run `veilio login` first.')
      expect(cloud.requests).toHaveLength(0)
    }
  )
})

describe('signed in', () => {
  it('lists the offline tools and the eight Cloud tools, each with a schema', async () => {
    signIn(home)
    expect((await listed()).sort()).toEqual([...OFFLINE, ...CLOUD].sort())
    for (const t of CLOUD_TOOLS) {
      expect(t.inputSchema.type).toBe('object')
      expect(t.description.length).toBeGreaterThan(40)
    }
  })

  it('the list follows the sign-in as it changes, with no restart', async () => {
    expect(await listed()).toHaveLength(5)
    signIn(home)
    expect(await listed()).toHaveLength(13)
  })
})

describe('the same outcome as the CLI (SC-002)', () => {
  it('maps_list: the maps the CLI lists, with whose each is', async () => {
    signIn(home, { team: true })
    const mine = cloud.add({ name: 'mine', map_data: await sealPersonal({ a: 'b' }, 'pmk') })
    const theirs = cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      name: 'routing',
      map_data: await sealTeam({ __CLS__1: 'R' }),
    })
    const r = await callToolAsync('maps_list', {}, ctx)
    const c = await cli(['maps', 'list'])
    expect(r.isError ?? false).toBe(false)
    for (const id of [mine.id, theirs.id]) {
      const cliLine = c.out.split('\n').find((l) => l.startsWith(id))!
      expect(r.text).toContain(cliLine)
    }
    expect(r.text).toMatch(/routing\s+\(a teammate’s\)/)
  })

  it('maps_pull: pulls into the project store with the personal-maps key, no passphrase', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({
      name: 'billing',
      map_data: await sealPersonal({ __CLS__1: 'Ledger' }, 'pmk'),
    })
    const r = await callToolAsync('maps_pull', { id: row.id }, ctx)
    expect(r.isError ?? false, r.text).toBe(false)
    expect(r.text).toContain('Pulled "billing" (1 symbols)')
    expect(loadMap(mapPath())).toEqual({ __CLS__1: 'Ledger' })
    // The result names the map and the count, never the entries.
    expect(r.text).not.toContain('Ledger')
  })

  it('maps_pull of a personal map with no personal-maps key: refused, naming `veilio vault unlock`', async () => {
    signIn(home)
    await cloud.withVault()
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'Ledger' }, 'vault') })
    const r = await callToolAsync('maps_pull', { id: row.id }, ctx)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('`veilio vault unlock`')
    // No passphrase was ever asked for: there is nobody to ask.
    expect(cloud.requests.some((x) => x.path === '/api/auth/vault')).toBe(false)
  })

  it('maps_pull of an old vault-key map with the key unlocked: the CLI’s refusal, word for word', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({
      name: 'old',
      map_data: await sealPersonal({ __CLS__1: 'Ledger' }, 'vault'),
    })
    const r = await callToolAsync('maps_pull', { id: row.id }, ctx)
    const c = await cli(['maps', 'pull', row.id])
    expect(r.isError).toBe(true)
    expect(sentenceOf(r.text)).toBe(sentenceOf(c.err))
    expect(r.text).toContain('`veilio vault unlock`')
  })

  it('maps_create personal and team: the same maps the CLI would make', async () => {
    signIn(home, { pmk: true, team: true, project: 'p-tools' })
    local({ __CLS__1: 'Ledger' })
    const p = await callToolAsync('maps_create', { name: 'mine', scope: 'personal' }, ctx)
    expect(p.isError ?? false, p.text).toBe(false)
    const t = await callToolAsync('maps_create', { name: 'shared', scope: 'team' }, ctx)
    expect(t.isError ?? false, t.text).toBe(false)
    expect(t.text).toMatch(/Published "shared" \(1 symbols\) to the team as map-\d+/)
    expect(cloud.maps.map((m) => [m.name, m.scope, m.project])).toEqual([
      ['mine', 'personal', null],
      ['shared', 'team', 'p-tools'],
    ])
  })

  it('maps_update: in place, and an update that drops nothing works without the destructive setting', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({
      name: 'billing',
      map_data: await sealPersonal({ __CLS__1: 'A' }, 'pmk'),
    })
    local({ __CLS__1: 'A', __FN__2: 'b' })
    const r = await callToolAsync('maps_update', { id: row.id }, ctx)
    expect(r.isError ?? false, r.text).toBe(false)
    expect(r.text).toContain(`Updated "billing" (${row.id}) in place: 2 symbols`)
    expect(cloud.maps).toHaveLength(1)
  })

  it.each([
    [
      'a teammate’s map',
      async () => {
        signIn(home, { team: true })
        local({ __CLS__1: 'X', __FN__2: 'y' })
        return cloud.add({
          scope: 'team',
          owner: TEAMMATE,
          name: 'routing',
          map_data: await sealTeam({ __CLS__1: 'X' }),
        }).id
      },
    ],
    [
      'a rotation owed',
      async () => {
        signIn(home, { team: true })
        local({ __CLS__1: 'X', __FN__2: 'y' })
        cloud.rotationOwed = true
        return cloud.add({ scope: 'team', map_data: await sealTeam({ __CLS__1: 'X' }) }).id
      },
    ],
    [
      'a clash',
      async () => {
        signIn(home, { team: true })
        local({ __CLS__1: 'X', __CLS__9: 'MyRouter' })
        cloud.add({
          scope: 'team',
          owner: TEAMMATE,
          map_data: await sealTeam({ __CLS__9: 'TheirRouter' }),
        })
        return cloud.add({ scope: 'team', map_data: await sealTeam({ __CLS__1: 'X' }) }).id
      },
    ],
    [
      'the team key locked',
      async () => {
        signIn(home)
        local({ __CLS__1: 'X', __FN__2: 'y' })
        return cloud.add({ scope: 'team', map_data: await sealTeam({ __CLS__1: 'X' }) }).id
      },
    ],
    [
      'entries dropped',
      async () => {
        signIn(home, { pmk: true })
        local({ __CLS__1: 'X' })
        return cloud.add({ map_data: await sealPersonal({ __CLS__1: 'X', __FN__2: 'y' }, 'pmk') })
          .id
      },
    ],
    [
      'a map that is not there',
      async () => {
        signIn(home, { pmk: true })
        local({ __CLS__1: 'X' })
        return 'nope'
      },
    ],
  ])('maps_update refuses %s in the CLI’s words', async (_label, setup) => {
    const id = await setup()
    const r = await callToolAsync('maps_update', { id }, ctx)
    const c = await cli(['maps', 'update', id])
    expect(r.isError).toBe(true)
    expect(c.code).not.toBe(0)
    expect(sentenceOf(r.text)).toBe(sentenceOf(c.err))
    // Refused before sending - except the rotation, which only the server
    // knows of, and refuses (423) without writing.
    const sent = cloud.requests.filter((x) => x.method === 'PATCH').length
    expect(sent).toBe(cloud.rotationOwed ? 2 : 0)
  })

  it('a clash result names placeholders, never the names behind them', async () => {
    signIn(home, { team: true })
    local({ __CLS__1: 'X', __CLS__9: 'MyRouter' })
    cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      map_data: await sealTeam({ __CLS__9: 'TheirRouter' }),
    })
    const id = cloud.add({ scope: 'team', map_data: await sealTeam({ __CLS__1: 'X' }) }).id
    const r = await callToolAsync('maps_update', { id }, ctx)
    expect(r.text).toContain('__CLS__9')
    expect(r.text).not.toContain('MyRouter')
    expect(r.text).not.toContain('TheirRouter')
  })

  it('maps_remove with the destructive setting on and the exact name: removed, as the CLI would', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({ name: 'billing', map_data: await sealPersonal({ a: 'b' }, 'pmk') })
    const r = await callToolAsync(
      'maps_remove',
      { id: row.id, confirmName: 'billing' },
      { ...ctx, destructive: true }
    )
    expect(r.isError ?? false, r.text).toBe(false)
    expect(r.text).toBe(`Removed "billing" (${row.id})`)
    expect(cloud.maps).toHaveLength(0)
  })

  it('team_status: account, team, project, key states - the state whoami and team unlock report', async () => {
    signIn(home, { team: true, pmk: true, project: 'p-tools' })
    cloud.rotationOwed = true
    const r = await callToolAsync('team_status', {}, ctx)
    expect(r.isError ?? false, r.text).toBe(false)
    expect(r.text).toContain('Account: me@example.test on https://veilio.test')
    expect(r.text).toContain('Team: team-1')
    expect(r.text).toContain('Project: tools (p-tools)')
    expect(r.text).toMatch(/Team key: unlocked here until /)
    expect(r.text).toMatch(/Personal-maps key: unlocked here until /)
    expect(r.text).toMatch(/Key change owed: yes, since 2026-10-19/)
    // Who could be asked is the server's business with the web app.
    expect(r.text).not.toContain(TEAMMATE)
  })

  it('team_status when locked and owing nothing says so plainly', async () => {
    signIn(home)
    const r = await callToolAsync('team_status', {}, ctx)
    expect(r.text).toMatch(/Team key: locked here - run `veilio team unlock`/)
    expect(r.text).toMatch(/Personal-maps key: locked here - run `veilio vault unlock`/)
    expect(r.text).toMatch(/Key change owed: no/)
    expect(r.text).toMatch(/Project: none chosen/)
  })

  it('projects_list and projects_use: the CLI’s list, and the same choice written', async () => {
    signIn(home)
    const r = await callToolAsync('projects_list', {}, ctx)
    const c = await cli(['projects'])
    for (const line of c.out.trim().split('\n')) expect(r.text).toContain(line)
    const u = await callToolAsync('projects_use', { project: 'tools' }, ctx)
    expect(u.isError ?? false, u.text).toBe(false)
    expect(readCredential(home)?.project).toBe('p-tools')
    const bad = await callToolAsync('projects_use', { project: 'payroll' }, ctx)
    const badCli = await cli(['projects', 'use', 'payroll'])
    expect(bad.isError).toBe(true)
    expect(sentenceOf(bad.text)).toBe(sentenceOf(badCli.err))
  })

  it('a project chosen in the CLI is the one the MCP tools use (US3 scenario 3)', async () => {
    signIn(home, { team: true })
    cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      project: 'p-tools',
      name: 'tools-map',
      map_data: await sealTeam({ __CLS__1: 'T' }),
    })
    cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      project: 'p-billing',
      name: 'billing-map',
      map_data: await sealTeam({ __CLS__1: 'B' }),
    })
    expect((await cli(['projects', 'use', 'tools'])).code).toBe(0)
    const r = await callToolAsync('maps_list', {}, ctx)
    expect(r.text).toContain('tools-map')
    expect(r.text).not.toContain('billing-map')
  })
})

describe('over stdio', () => {
  it('a Cloud tool answers after the offline frames behind it, matched by id', async () => {
    signIn(home)
    const sent: JsonRpcResponse[] = []
    const reader = new FrameReader(ctx, (r) => sent.push(r))
    reader.push(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"maps_list","arguments":{}}}\n' +
        '{"jsonrpc":"2.0","id":2,"method":"ping"}\n'
    )
    // The offline answer is immediate; the Cloud one follows.
    expect(sent.map((r) => r.id)).toEqual([2])
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    const listing = sent.find((r) => r.id === 1)!.result as { content: { text: string }[] }
    expect(listing.content[0]!.text).toMatch(/No maps in Cloud yet/)
  })
})

describe('the namespace follows the project while the server runs', () => {
  afterEach(() => resetNamespaceCache())

  it('a project chosen in a terminal after start is used from the next call on', async () => {
    resetNamespaceCache()
    signIn(home, { team: true, project: 'p-billing' })
    cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      project: 'p-billing',
      map_data: await sealTeam({ __CLS__1: 'Alpha' }),
    })
    cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      project: 'p-tools',
      map_data: await sealTeam({ __CLS__5: 'Gamma' }),
    })
    await primeNamespace(home)
    expect(getNamespace().namespace).toEqual({ __CLS__1: 'Alpha' })

    expect((await cli(['projects', 'use', 'tools'])).code).toBe(0)
    const first = callTool('anonymize_text', { text: 'export class Gamma {}' }, ctx)
    expect(first.text).toMatch(/another project chosen/)
    await namespaceSettled()
    expect(getNamespace().namespace).toEqual({ __CLS__5: 'Gamma' })
    expect(refreshNamespaceIfStale()).toBeNull()
    const next = callTool('anonymize_text', { text: 'export class Gamma {}' }, ctx)
    expect(next.text).toContain('__CLS__5')
  })

  it('a team map written through this server reloads it', async () => {
    resetNamespaceCache()
    signIn(home, { team: true })
    await primeNamespace(home)
    expect(getNamespace().source).toBe('local')
    local({ __CLS__1: 'Ledger' })
    const created = await callToolAsync('maps_create', { name: 'shared', scope: 'team' }, ctx)
    expect(created.isError ?? false, created.text).toBe(false)
    expect(refreshNamespaceIfStale()).toBe('changed')
    await namespaceSettled()
    expect(getNamespace().namespace).toEqual({ __CLS__1: 'Ledger' })
  })
})
