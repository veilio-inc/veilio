import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { credentialPath, readCredential } from '../src/credential.js'
import { STORE_DIR, STORE_FILE, saveMap } from '../src/store.js'
import { FakeCloud, TEAMMATE, sealTeam, signIn } from './helpers/fake-cloud.js'

/**
 * Working in a chosen project (spec 052 US3, T019).
 *
 * The choice is kept WITH THE SIGN-IN (`credential.json` `project`), so the
 * MCP server started later for the same account works in the same project
 * without being told (FR-012). Every team map call then carries it, and the
 * proof that it matters is SC-004: masking in one project shows none of the
 * other project's placeholders.
 */

let home: string
let cwd: string
let cloud: FakeCloud

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-proj-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-proj-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

async function run(
  argv: string[],
  stdin = ''
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => stdin,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    password: async () => '',
  }
  return { code: await main(argv, io), out, err }
}

describe('veilio projects', () => {
  it('lists the team’s projects, marking the one in use', async () => {
    signIn(home, { project: 'p-tools' })
    const r = await run(['projects'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toMatch(/^ {2}p-billing {2}billing/m)
    expect(r.out).toMatch(/^\* p-tools {2}tools .*in use/m)
    expect(cloud.requests.map((x) => x.path)).toEqual(['/api/projects'])
  })

  it('with none chosen, marks the default and says what that means', async () => {
    signIn(home)
    const r = await run(['projects', 'list'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toMatch(/p-billing {2}billing .*default/)
    expect(r.err).toMatch(/No project is chosen/)
    expect(r.err).toContain('`veilio projects use <name>`')
  })

  it('an account in no team: says so, and how to get one', async () => {
    signIn(home)
    cloud.teamId = null
    const r = await run(['projects'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/works in no project yet/)
  })
})

describe('veilio projects use', () => {
  it('chooses by name and keeps the choice with the sign-in', async () => {
    signIn(home)
    const r = await run(['projects', 'use', 'tools'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toContain('tools (p-tools)')
    expect(readCredential(home)?.project).toBe('p-tools')
    // Everything else about the sign-in is untouched.
    expect(readCredential(home)?.token).toBe('tok')
  })

  it('chooses by id too', async () => {
    signIn(home)
    expect((await run(['projects', 'use', 'p-billing'])).code).toBe(EXIT_OK)
    expect(readCredential(home)?.project).toBe('p-billing')
  })

  it('a project the team does not work in is refused, and nothing changes (FR-014)', async () => {
    signIn(home, { project: 'p-tools' })
    const before = readFileSync(credentialPath(home), 'utf8')
    const r = await run(['projects', 'use', 'payroll'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/"payroll" is not a project your team works in/)
    expect(readFileSync(credentialPath(home), 'utf8')).toBe(before)
  })

  it('two projects with one name: refused, asking for the id', async () => {
    signIn(home)
    cloud.projects.push({ id: 'p-tools-2', name: 'tools' })
    const before = readFileSync(credentialPath(home), 'utf8')
    const r = await run(['projects', 'use', 'tools'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/2 projects are called "tools"/)
    expect(readFileSync(credentialPath(home), 'utf8')).toBe(before)
  })

  it('no project named: usage', async () => {
    signIn(home)
    const r = await run(['projects', 'use'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/which project/)
  })

  it('signed out: the sign-in sentence, and no request', async () => {
    const r = await run(['projects', 'use', 'tools'])
    expect(r.err).toBe('veilio: not signed in. Run `veilio login` first.\n')
    expect(cloud.requests).toHaveLength(0)
  })
})

describe('every map call carries the project (FR-013)', () => {
  it('list, the team namespace and a team push all name it', async () => {
    signIn(home, { team: true, project: 'p-tools' })
    saveMap(join(cwd, STORE_DIR, STORE_FILE), { __CLS__1: 'Ledger' }, { force: true })
    expect((await run(['maps', 'list'])).code).toBe(EXIT_OK)
    const pushed = await run(['maps', 'push', '--team', 'mine'])
    expect(pushed.code, pushed.err).toBe(EXIT_OK)

    const gets = cloud.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/api/maps'))
    expect(gets.length).toBeGreaterThan(1)
    for (const g of gets.filter(
      (r) => r.path === '/api/maps' || r.path === '/api/maps/team-envelopes'
    ))
      expect(g.query.get('project'), g.path).toBe('p-tools')
    const post = cloud.requests.find((r) => r.method === 'POST')!
    expect(post.body?.project).toBe('p-tools')
    expect(cloud.maps.find((m) => m.name === 'mine')?.project).toBe('p-tools')
  })

  it('a personal push does not carry a project: a personal map has none', async () => {
    signIn(home, { pmk: true, project: 'p-tools' })
    saveMap(join(cwd, STORE_DIR, STORE_FILE), { __CLS__1: 'Ledger' }, { force: true })
    expect((await run(['maps', 'push', 'mine'])).code).toBe(EXIT_OK)
    expect(cloud.requests.find((r) => r.method === 'POST')!.body?.project).toBeUndefined()
  })

  it('the chosen project removed: the next command says so, and never moves to another', async () => {
    signIn(home, { project: 'p-gone' })
    const r = await run(['maps', 'list'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(
      /the project chosen for this sign-in \(p-gone\) is not one your team works in any more/
    )
    expect(r.err).toMatch(/No other project was used instead/)
    expect(cloud.requests.every((x) => x.query.get('project') === 'p-gone')).toBe(true)
  })

  it('a removed project is not retried as if Cloud were down: one request, no wait', async () => {
    signIn(home, { team: true, project: 'p-gone' })
    writeFileSync(join(cwd, 'g.ts'), 'export class Gamma {}\n')
    const started = Date.now()
    const r = await run(['scrub', 'g.ts'])
    expect(r.code).toBe(EXIT_OK)
    expect(cloud.requests.filter((x) => x.path === '/api/maps')).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('masking in one project uses none of another’s placeholders (SC-004)', () => {
  beforeEach(async () => {
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
    writeFileSync(join(cwd, 'g.ts'), 'export class Gamma {}\n')
  })

  it('in billing, Gamma is a new name, numbered above billing’s own', async () => {
    signIn(home, { team: true, project: 'p-billing' })
    const r = await run(['scrub', 'g.ts'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toContain('__CLS__2')
    expect(r.out).not.toContain('__CLS__5')
  })

  it('in tools, Gamma is the team’s __CLS__5', async () => {
    signIn(home, { team: true, project: 'p-tools' })
    const r = await run(['scrub', 'g.ts'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toContain('__CLS__5')
  })

  it('switching project with `projects use` switches the namespace', async () => {
    signIn(home, { team: true, project: 'p-billing' })
    expect((await run(['projects', 'use', 'tools'])).code).toBe(EXIT_OK)
    const r = await run(['scrub', 'g.ts'])
    expect(r.out).toContain('__CLS__5')
  })
})
