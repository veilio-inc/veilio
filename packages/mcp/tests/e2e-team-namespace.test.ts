import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { writeCredential } from '@veilio-inc/cli/credential'
import { writeTeamUnlock, expiryFrom } from '@veilio-inc/cli/team-unlock'
import { toBase64 } from '@veilio-inc/engine'

/**
 * The whole feature, through the real binary, against a real HTTP server.
 *
 * Every other test in this package calls into the module directly. That covers
 * the logic and misses the thing that actually broke: the MCP server asked
 * Cloud for a field Cloud had stopped sending, and nothing failed — it degraded
 * to `local`, which is correct behaviour and indistinguishable from success
 * unless somebody checks what the namespace resolved to.
 *
 * So this spawns `dist/index.js` the way an agent does, serves it the shape a
 * real Cloud serves, and asserts the placeholder a teammate would see. If the
 * contract between the two repositories drifts again, this is what fails.
 */

const DIST = resolve(import.meta.dirname, '..', 'dist', 'index.js')
const ACCOUNT = 'a@example.test'

const cleanup: (() => void)[] = []

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

const subtle = globalThis.crypto.subtle
const buf = (u: Uint8Array) => u as unknown as Uint8Array<ArrayBuffer>

async function encryptTeamMap(
  teamKeyRaw: Uint8Array,
  map: Record<string, string>
): Promise<string> {
  const key = await subtle.importKey('raw', buf(teamKeyRaw), { name: 'AES-GCM' }, false, [
    'encrypt',
  ])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(map))
  )
  return JSON.stringify({ v: 1, alg: 'AES-256-GCM-TEAM', iv: toBase64(iv), data: toBase64(data) })
}

/** A Cloud that behaves like the current one: no `teamNamespace` in the listing. */
async function startCloud(teamKeyRaw: Uint8Array): Promise<{ url: string; server: Server }> {
  const created = '2026-01-01T00:00:00.000Z'
  const summary = {
    id: 'm1',
    name: 'team map',
    scope: 'team',
    identifier_count: 1,
    created_at: created,
    updated_at: created,
    storage: 'client-envelope',
  }
  const mapData = await encryptTeamMap(teamKeyRaw, { __CLS__1: 'PaymentGateway' })

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    res.setHeader('content-type', 'application/json')
    if (path === '/api/maps') {
      res.end(
        JSON.stringify({
          personalMaps: [],
          teamMaps: [summary],
          team: { id: 'team-1' },
          plan: 'team',
        })
      )
      return
    }
    if (path === '/api/maps/m1') {
      res.end(JSON.stringify({ ...summary, map_data: mapData }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  })

  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as { port: number }).port
  cleanup.push(() => server.close())
  return { url: `http://127.0.0.1:${port}`, server }
}

/** Drive the spawned server over stdio and return the anonymize result text. */
function anonymizeThroughServer(home: string, cwd: string, text: string): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [DIST, '--root', cwd], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    cleanup.push(() => child.kill())

    let out = ''
    const timer = setTimeout(() => fail(new Error(`timed out; stdout so far: ${out}`)), 15_000)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
      for (const line of out.split('\n')) {
        if (!line.trim()) continue
        const msg = JSON.parse(line) as {
          id?: number
          result?: { content?: { text?: string }[] }
        }
        if (msg.id === 2 && msg.result) {
          clearTimeout(timer)
          ok(msg.result.content?.[0]?.text ?? '')
          child.kill()
          return
        }
      }
    })
    child.on('error', fail)

    const send = (msg: unknown): void => {
      child.stdin.write(`${JSON.stringify(msg)}\n`)
    }
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'anonymize_text', arguments: { text } },
    })
  })
}

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const SOURCE = 'export class PaymentGateway {}\n'

describe('the built MCP server, end to end', () => {
  beforeAll(() => {
    // Fail rather than skip: a skipped test on a missing build reports green on
    // exactly the run where nothing was built.
    if (!existsSync(DIST)) {
      throw new Error(`${DIST} is missing. Run \`npm run build --workspace=packages/mcp\` first.`)
    }
  })

  it('resolves the team namespace from keys on disk, against a Cloud that sends none', async () => {
    const teamKeyRaw = crypto.getRandomValues(new Uint8Array(32))
    const cloud = await startCloud(teamKeyRaw)
    const home = freshDir('veilio-e2e-home-')

    writeCredential({ token: 't', account: ACCOUNT, instance: cloud.url }, home)
    writeTeamUnlock(
      {
        v: 1,
        instance: cloud.url,
        account: ACCOUNT,
        teamId: 'team-1',
        expiresAt: expiryFrom(new Date()),
        keys: [{ version: 1, key: toBase64(teamKeyRaw) }],
      },
      home
    )

    const text = await anonymizeThroughServer(home, freshDir('veilio-e2e-work-'), SOURCE)

    // The teammate's placeholder, not one this process invented. Without the
    // client-side merge both of these fail: the source says `local`, and
    // PaymentGateway gets whatever number this engine reached next.
    expect(text).toContain('Namespace: team')
    expect(text).toContain('__CLS__1')
    expect(text).not.toContain('PaymentGateway')
  })

  it('says local, and still works, when nothing is unlocked', async () => {
    const teamKeyRaw = crypto.getRandomValues(new Uint8Array(32))
    const cloud = await startCloud(teamKeyRaw)
    const home = freshDir('veilio-e2e-home-')
    writeCredential({ token: 't', account: ACCOUNT, instance: cloud.url }, home)

    const text = await anonymizeThroughServer(home, freshDir('veilio-e2e-work-'), SOURCE)

    expect(text).toContain('Namespace: local')
    expect(text).not.toContain('PaymentGateway')
  })

  it('serves a signed-out machine without reaching the network at all', async () => {
    // Cloud is started but never addressed: with no credential there is nothing
    // to ask and nobody to ask it of.
    const home = freshDir('veilio-e2e-home-')

    const text = await anonymizeThroughServer(home, freshDir('veilio-e2e-work-'), SOURCE)

    expect(text).toContain('Namespace: local')
    expect(text).not.toContain('PaymentGateway')
  })
})
