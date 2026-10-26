import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { credentialPath, readCredential } from '../src/credential.js'
import { STORE_DIR, STORE_FILE, saveMap } from '../src/store.js'
import {
  FakeCloud,
  TEAMMATE,
  sealPersonal,
  sealTeam,
  signIn,
  type Recorded,
} from './helpers/fake-cloud.js'
import { formatProjectsList } from '../src/client/projects.js'
import { runBinary, serveOverHttp } from './helpers/http-fake.js'
import { CloudError } from '../src/cloud.js'
import { refusalFromCloudError } from '../src/client/wording.js'

/**
 * `VEILIO_PROJECT` (spec 052 FR-012a, founder 2026-10-26).
 *
 * A CI runner starts clean, so a pipeline cannot depend on a stored `projects
 * use`; and a repository's `.mcp.json` pins its own project through `env`. So
 * the variable overrides the stored choice for the process it is set in. The
 * rules, each with a test below and a mutant in the commit:
 *
 *   - it wins over the stored choice, by name or by id;
 *   - a value naming no project, or a name two share, is REFUSED, naming the
 *     value and the variable - never replaced by the stored choice or the
 *     default, and with no request carrying any other project;
 *   - empty, or spaces only, is unset;
 *   - every line that names the project says "(from VEILIO_PROJECT)";
 *   - `projects` marks the one in use and says the override is in force;
 *     `projects use` stores, and warns;
 *   - it is never written down, so two processes in one HOME scope apart;
 *   - signed out, nothing changes.
 */

let home: string
let cwd: string
let cloud: FakeCloud
let billingMap: string
let toolsMap: string

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'veilio-penv-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-penv-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
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
  writeFileSync(join(cwd, 'g.ts'), 'export class Gamma {}\n')
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

async function run(
  argv: string[],
  env: Record<string, string | undefined> = {},
  stdin = ''
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    env,
    stdin: async () => stdin,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    password: async () => '',
  }
  return { code: await main(argv, io), out, err }
}

const storePath = (): string => join(cwd, STORE_DIR, STORE_FILE)

/** The project a request carried, in its query or its body. */
const carried = (r: Recorded): unknown => r.query.get('project') ?? r.body?.project ?? null

/** Only the listing that resolves the variable - and it names no project. */
function onlyTheListing(): void {
  expect(cloud.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/projects'])
  for (const r of cloud.requests) expect(carried(r), r.path).toBeNull()
}

describe('VEILIO_PROJECT wins over the stored choice', () => {
  it('by name: maps list shows the variable’s project, not the stored one', async () => {
    signIn(home, { project: 'p-billing' })
    const r = await run(['maps', 'list'], { VEILIO_PROJECT: 'tools' })
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toContain(toolsMap)
    expect(r.out).not.toContain(billingMap)
    const lists = cloud.requests.filter((x) => x.path === '/api/maps')
    expect(lists).toHaveLength(1)
    expect(lists[0]!.query.get('project')).toBe('p-tools')
    // Resolved through the server's listing, once.
    expect(cloud.requests.filter((x) => x.path === '/api/projects')).toHaveLength(1)
  })

  it('by id too', async () => {
    signIn(home, { project: 'p-billing' })
    const r = await run(['maps', 'list'], { VEILIO_PROJECT: 'p-tools' })
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toContain(toolsMap)
    expect(r.out).not.toContain(billingMap)
  })

  it('scrub numbers from the variable’s project: Gamma is tools’ __CLS__5', async () => {
    signIn(home, { team: true, project: 'p-billing' })
    const r = await run(['scrub', 'g.ts'], { VEILIO_PROJECT: 'tools' })
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toContain('__CLS__5')
    for (const x of cloud.requests.filter((q) => q.path.startsWith('/api/maps')))
      expect(x.query.get('project'), x.path).toBe('p-tools')
  })

  it('a team push lands in the variable’s project - and the stored choice is untouched', async () => {
    signIn(home, { team: true, project: 'p-billing' })
    const before = readFileSync(credentialPath(home), 'utf8')
    saveMap(storePath(), { __CLS__1: 'Gamma' }, { force: true })
    // __CLS__1 is billing's Alpha; in tools it is free. Pushed into tools,
    // it is accepted - which it would not be in billing.
    const r = await run(['maps', 'push', '--team', 'mine'], { VEILIO_PROJECT: 'tools' })
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(cloud.requests.find((x) => x.method === 'POST')!.body?.project).toBe('p-tools')
    expect(cloud.maps.find((m) => m.name === 'mine')?.project).toBe('p-tools')
    // Never written down: the next shell without the variable is in billing.
    expect(readFileSync(credentialPath(home), 'utf8')).toBe(before)
  })
})

describe('a value that names no project is refused, naming it (never a fallback)', () => {
  it('unknown name: maps list refuses, and only the listing went out', async () => {
    signIn(home, { project: 'p-billing' })
    const r = await run(['maps', 'list'], { VEILIO_PROJECT: 'payroll' })
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.out).toBe('')
    expect(r.err).toContain(
      'VEILIO_PROJECT is "payroll", which is not a project your team works in'
    )
    expect(r.err).toContain('No other project was used instead.')
    onlyTheListing()
  })

  it('a name two projects share: refused, asking for the id, and only the listing went out', async () => {
    signIn(home, { project: 'p-billing' })
    cloud.projects.push({ id: 'p-tools-2', name: 'tools' })
    const r = await run(['maps', 'list'], { VEILIO_PROJECT: 'tools' })
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('VEILIO_PROJECT is "tools", and 2 projects are called that')
    expect(r.err).toContain('id')
    onlyTheListing()
  })

  it('with nothing stored either: refused, not the default', async () => {
    signIn(home)
    const r = await run(['maps', 'list'], { VEILIO_PROJECT: 'payroll' })
    expect(r.code).toBe(EXIT_ERROR)
    onlyTheListing()
  })

  it('maps push --team: refused before anything is sealed or sent', async () => {
    signIn(home, { team: true, project: 'p-billing' })
    saveMap(storePath(), { __CLS__9: 'Fresh' }, { force: true })
    const r = await run(['maps', 'push', '--team', 'mine'], { VEILIO_PROJECT: 'payroll' })
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('"payroll"')
    expect(cloud.writes()).toHaveLength(0)
    onlyTheListing()
  })

  it('scrub: refused, nothing masked, nothing stored - not numbered from the local map', async () => {
    signIn(home, { team: true, project: 'p-billing' })
    const r = await run(['scrub', 'g.ts'], { VEILIO_PROJECT: 'payroll' })
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.out).toBe('')
    expect(r.err).toContain('VEILIO_PROJECT is "payroll"')
    expect(existsSync(storePath())).toBe(false)
    onlyTheListing()
  })

  it('scrub with an ambiguous name: refused the same way', async () => {
    signIn(home, { team: true })
    cloud.projects.push({ id: 'p-tools-2', name: 'tools' })
    const r = await run(['scrub', 'g.ts'], { VEILIO_PROJECT: 'tools' })
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.out).toBe('')
    expect(r.err).toContain('2 projects are called that')
    onlyTheListing()
  })

  it('restore of text holding a placeholder: refused', async () => {
    signIn(home, { team: true, project: 'p-billing' })
    saveMap(storePath(), { __CLS__1: 'Alpha' }, { force: true })
    const r = await run(['restore'], { VEILIO_PROJECT: 'payroll' }, 'class __CLS__1 {}\n')
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.out).toBe('')
    expect(r.err).toContain('VEILIO_PROJECT is "payroll"')
    onlyTheListing()
  })
})

describe('the listing that resolves the variable keeps the 5 s cap', () => {
  it('a hung /api/projects: scrub gives up within the cap, as for any team read', async () => {
    signIn(home, { team: true })
    vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) =>
      String(url).includes('/api/projects')
        ? new Promise((_, reject) =>
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            )
          )
        : cloud.fetch(url, init)
    )
    const started = Date.now()
    const r = await run(['scrub', 'g.ts'], { VEILIO_PROJECT: 'tools' })
    expect(Date.now() - started).toBeLessThan(8000)
    expect(r.err).toContain('did not wait for Cloud')
    // Never another project: nothing past the listing was asked.
    expect(cloud.requests.filter((x) => x.path.startsWith('/api/maps'))).toHaveLength(0)
  }, 15_000)
})

describe('an empty value counts as unset', () => {
  it.each([[''], ['   ']])('%j: the stored choice applies, and no listing is asked', async (v) => {
    signIn(home, { project: 'p-billing' })
    const r = await run(['maps', 'list'], { VEILIO_PROJECT: v })
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toContain(billingMap)
    expect(r.out).not.toContain(toolsMap)
    expect(cloud.requests.map((x) => x.path)).toEqual(['/api/maps'])
    expect(cloud.requests[0]!.query.get('project')).toBe('p-billing')
    expect(r.err).toContain('team maps of project p-billing (')
    expect(r.err).not.toContain('VEILIO_PROJECT')
  })

  it('empty with nothing stored: no project at all, as before', async () => {
    signIn(home)
    const r = await run(['maps', 'list'], { VEILIO_PROJECT: '' })
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(cloud.requests.every((x) => carried(x) === null)).toBe(true)
  })
})

describe('the wording says when the variable chose the project', () => {
  it('maps list: "project tools (from VEILIO_PROJECT)"', async () => {
    signIn(home, { project: 'p-billing' })
    const r = await run(['maps', 'list'], { VEILIO_PROJECT: 'p-tools' })
    expect(r.err).toContain('team maps of project tools (from VEILIO_PROJECT)')
  })

  it('whoami: names the value as set, and still makes no request', async () => {
    signIn(home, { project: 'p-billing' })
    const r = await run(['whoami'], { VEILIO_PROJECT: 'tools' })
    expect(r.out).toContain(', project tools (from VEILIO_PROJECT)')
    expect(r.out).not.toContain('p-billing')
    expect(cloud.requests).toHaveLength(0)
  })

  it('projects: marks the variable’s project, says it is in force, one request', async () => {
    signIn(home, { project: 'p-billing' })
    const r = await run(['projects'], { VEILIO_PROJECT: 'tools' })
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toMatch(/^\* p-tools {2}tools {2}\(in use, from VEILIO_PROJECT/m)
    expect(r.out).toMatch(/^ {2}p-billing /m)
    expect(r.err).toContain('VEILIO_PROJECT is "tools", so that project is in use here')
    expect(r.err).toContain('(p-billing) applies again once it is unset')
    expect(cloud.requests.map((x) => x.path)).toEqual(['/api/projects'])
  })

  it('projects with a value naming none: still lists, marks none, and says so', async () => {
    signIn(home, { project: 'p-billing' })
    const r = await run(['projects'], { VEILIO_PROJECT: 'payroll' })
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).not.toMatch(/^\*/m)
    expect(r.err).toContain('VEILIO_PROJECT is "payroll", which is none of these projects')
  })

  it('projects use: stores the choice, and warns the variable overrides it here', async () => {
    signIn(home, { project: 'p-tools' })
    const r = await run(['projects', 'use', 'billing'], { VEILIO_PROJECT: 'tools' })
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(readCredential(home)?.project).toBe('p-billing')
    expect(r.err).toContain(
      'VEILIO_PROJECT is set ("tools") in this shell, and it overrides this choice'
    )
  })

  it('projects use without the variable: no warning', async () => {
    signIn(home)
    const r = await run(['projects', 'use', 'billing'])
    expect(r.err).toBe('')
  })

  it('a map outside the variable’s project: the refusal names it as the variable’s', async () => {
    signIn(home, { team: true, project: 'p-tools' })
    const mine = cloud.add({
      scope: 'team',
      name: 'mine',
      project: 'p-billing',
      map_data: await sealTeam({ __CLS__1: 'Alpha' }),
    }).id
    saveMap(storePath(), { __CLS__1: 'Alpha' }, { force: true })
    const r = await run(['maps', 'update', mine], { VEILIO_PROJECT: 'tools' })
    expect(r.code).toBe(EXIT_ERROR)
    // One clause, not "(from VEILIO_PROJECT) (the project in use)".
    expect(r.err).toContain(`No map ${mine} in project tools (set by VEILIO_PROJECT).`)
    expect(r.err).not.toContain('the project in use')
    expect(r.err).not.toContain('(from VEILIO_PROJECT)')
    expect(r.err).toContain('Set VEILIO_PROJECT to another project, or unset it')
    expect(cloud.writes()).toHaveLength(0)
  })
})

describe('a project removed after the variable resolved it', () => {
  it('the server’s 404 is said as the variable’s project gone, not the stored choice’s', () => {
    const gone = new CloudError('server', 'Project not found', 404)
    const viaEnv = refusalFromCloudError(gone, { project: 'tools', override: true })
    expect(viaEnv.message).toContain('the project VEILIO_PROJECT names (tools)')
    expect(viaEnv.message).toContain('No other project was used instead.')
    expect(viaEnv.resolve).toContain('VEILIO_PROJECT')
    const stored = refusalFromCloudError(gone, { project: 'p-tools' })
    expect(stored.message).toContain('the project chosen for this sign-in (p-tools)')
  })
})

describe('signed out, the variable changes nothing', () => {
  it('maps list: the sign-in sentence, and no request', async () => {
    const r = await run(['maps', 'list'], { VEILIO_PROJECT: 'tools' })
    expect(r.err).toBe('veilio: not signed in. Run `veilio login` first.\n')
    expect(cloud.requests).toHaveLength(0)
  })

  it('scrub: byte-identical to a run without it, offline', async () => {
    const withIt = await run(['scrub', 'g.ts'], { VEILIO_PROJECT: 'payroll' })
    rmSync(join(cwd, STORE_DIR), { recursive: true, force: true })
    const without = await run(['scrub', 'g.ts'])
    expect(withIt.code).toBe(EXIT_OK)
    expect(withIt.out).toBe(without.out)
    expect(withIt.err).toBe(without.err)
    expect(withIt.out).toContain('__CLS__1')
    expect(cloud.requests).toHaveLength(0)
  })
})

describe('two processes, one HOME, two values', () => {
  it('scope independently, concurrently, and leave the stored choice alone', async () => {
    vi.unstubAllGlobals()
    const { url, close } = await serveOverHttp(cloud)
    try {
      signIn(home, { instance: url, project: 'p-billing' })
      const before = readFileSync(credentialPath(home), 'utf8')
      const bin = resolve(import.meta.dirname, '..', 'dist', 'index.js')
      const [inTools, inBilling, unset] = await Promise.all([
        runBinary(bin, ['maps', 'list'], { cwd, home, env: { VEILIO_PROJECT: 'tools' } }),
        runBinary(bin, ['maps', 'list'], { cwd, home, env: { VEILIO_PROJECT: 'p-billing' } }),
        runBinary(bin, ['maps', 'list'], { cwd, home, env: { VEILIO_PROJECT: '' } }),
      ])
      expect(inTools.code, inTools.err).toBe(0)
      expect(inTools.out).toContain(toolsMap)
      expect(inTools.out).not.toContain(billingMap)
      expect(inTools.err).toContain('project tools (from VEILIO_PROJECT)')
      expect(inBilling.code, inBilling.err).toBe(0)
      expect(inBilling.out).toContain(billingMap)
      expect(inBilling.out).not.toContain(toolsMap)
      expect(inBilling.err).toContain('project billing (from VEILIO_PROJECT)')
      // And a third beside them, set empty: the stored choice, as it was.
      expect(unset.out).toContain(billingMap)
      expect(unset.err).not.toContain('VEILIO_PROJECT')
      // And one more on its own, last, so no other run can write after it:
      // the variable is never written down.
      await runBinary(bin, ['maps', 'list'], { cwd, home, env: { VEILIO_PROJECT: 'tools' } })
      expect(readFileSync(credentialPath(home), 'utf8')).toBe(before)
    } finally {
      await close()
    }
  }, 30_000)
})

describe('the variable applies to team maps only: a personal map is never refused by it', () => {
  const bad = { VEILIO_PROJECT: 'payroll' }
  const projectListings = (): number =>
    cloud.requests.filter((r) => r.path === '/api/projects').length

  it('maps update of a personal map: done, and the variable is never resolved', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({ name: 'mine', map_data: await sealPersonal({ __CLS__1: 'A' }, 'pmk') })
    saveMap(storePath(), { __CLS__1: 'A', __FN__2: 'b' }, { force: true })
    const r = await run(['maps', 'update', row.id], bad)
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.err).not.toContain('VEILIO_PROJECT')
    expect(projectListings()).toBe(0)
  })

  it('maps rm of a personal map: done, and the variable is never resolved', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({ name: 'mine', map_data: await sealPersonal({ __CLS__1: 'A' }, 'pmk') })
    const r = await run(['maps', 'rm', row.id], bad)
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toBe(`Removed "mine" (${row.id})\n`)
    expect(projectListings()).toBe(0)
  })

  it('maps pull of a personal map: done, and the variable is never resolved', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({ name: 'mine', map_data: await sealPersonal({ __CLS__1: 'A' }, 'pmk') })
    const r = await run(['maps', 'pull', row.id], bad)
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(projectListings()).toBe(0)
  })

  it('maps update of a team map: the bad value is still refused, naming it', async () => {
    signIn(home, { team: true })
    saveMap(storePath(), { __CLS__5: 'Gamma', __FN__2: 'b' }, { force: true })
    const r = await run(['maps', 'update', toolsMap], bad)
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('VEILIO_PROJECT is "payroll"')
    expect(cloud.writes()).toHaveLength(0)
  })

  it('maps rm of a team map: the bad value is still refused, and nothing is deleted', async () => {
    signIn(home, { team: true })
    const r = await run(['maps', 'rm', toolsMap], bad)
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('VEILIO_PROJECT is "payroll"')
    expect(cloud.writes()).toHaveLength(0)
  })

  it('maps rm of a team map in the variable’s project goes through', async () => {
    signIn(home, { team: true })
    const mine = cloud.add({
      scope: 'team',
      name: 'mine',
      project: 'p-tools',
      map_data: await sealTeam({ __CLS__6: 'Delta' }),
    })
    const r = await run(['maps', 'rm', mine.id], { VEILIO_PROJECT: 'tools' })
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toBe(`Removed "mine" (${mine.id})\n`)
  })
})

describe('maps pull under the variable', () => {
  it('a team map of the variable’s project is pulled', async () => {
    signIn(home, { team: true })
    const r = await run(['maps', 'pull', toolsMap], { VEILIO_PROJECT: 'tools' })
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(JSON.parse(readFileSync(storePath(), 'utf8'))).toMatchObject({
      map: { __CLS__5: 'Gamma' },
    })
  })

  it('a team map of ANOTHER project is refused, naming the variable, and nothing is written', async () => {
    signIn(home, { team: true })
    const r = await run(['maps', 'pull', billingMap], { VEILIO_PROJECT: 'tools' })
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain(`No map ${billingMap} in project tools (set by VEILIO_PROJECT).`)
    expect(existsSync(storePath())).toBe(false)
  })

  it('a bad value is refused for a team map, as for every other command', async () => {
    signIn(home, { team: true })
    const r = await run(['maps', 'pull', toolsMap], { VEILIO_PROJECT: 'payroll' })
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('VEILIO_PROJECT is "payroll"')
    expect(existsSync(storePath())).toBe(false)
  })

  it('without the variable, a team map of any project is pulled, as before', async () => {
    signIn(home, { team: true })
    const r = await run(['maps', 'pull', billingMap])
    expect(r.code, r.err).toBe(EXIT_OK)
  })
})

describe('projects use and maps list under the variable say what is true', () => {
  it('projects use: stdout does not claim to be working in the stored choice', async () => {
    signIn(home, { project: 'p-tools' })
    const r = await run(['projects', 'use', 'billing'], { VEILIO_PROJECT: 'tools' })
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).not.toContain('Now working in')
    expect(r.out).toContain('Saved project billing (p-billing)')
    expect(r.out).toContain('VEILIO_PROJECT (=tools) is in use here')
  })

  it('projects use without the variable still says it is now working there', async () => {
    signIn(home)
    const r = await run(['projects', 'use', 'billing'])
    expect(r.out).toContain('Now working in project billing (p-billing)')
  })

  it('maps list: the hint says the variable chose the project', async () => {
    signIn(home, { team: true, project: 'p-billing' })
    const r = await run(['maps', 'list'], { VEILIO_PROJECT: 'tools' })
    expect(r.err).toContain(
      'team maps of project tools (from VEILIO_PROJECT) - VEILIO_PROJECT chose it'
    )
    expect(r.err).not.toContain('`veilio projects` to change')
  })

  it('maps list without the variable keeps its hint', async () => {
    signIn(home, { team: true, project: 'p-billing' })
    const r = await run(['maps', 'list'])
    expect(r.err).toContain('team maps of project p-billing (`veilio projects` to change)')
  })
})

describe('the projects list is rendered in one place', () => {
  const rows = [
    { id: 'p-a', name: 'a', maps: 1, inUse: true, isDefault: true },
    { id: 'p-b', name: 'b', maps: null, inUse: false, isDefault: false },
  ]

  it('marks, the override variant, and the override sentence', () => {
    const plain = formatProjectsList(
      { projects: rows, chosen: 'p-a', override: null },
      { surface: 'cli' }
    )
    expect(plain.lines).toEqual(['* p-a  a  (in use, default, 1 team map)', '  p-b  b  ()'])
    expect(plain.note).toBeNull()
    const pinned = formatProjectsList(
      { projects: rows, chosen: 'p-b', override: { value: 'a', id: 'p-a' } },
      { surface: 'cli' }
    )
    expect(pinned.lines[0]).toBe('* p-a  a  (in use, from VEILIO_PROJECT, default, 1 team map)')
    expect(pinned.note).toContain('VEILIO_PROJECT is "a", so that project is in use here')
  })

  it('none chosen: the note names the surface’s own way to choose', () => {
    const none = { projects: rows, chosen: null, override: null }
    expect(formatProjectsList(none, { surface: 'cli' }).note).toContain(
      'veilio projects use <name>'
    )
    expect(formatProjectsList(none, { surface: 'mcp' }).note).toContain('projects_use chooses one')
  })
})
