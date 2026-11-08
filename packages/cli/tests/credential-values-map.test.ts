import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE, loadMap } from '../src/store.js'
import { FakeCloud, PASSPHRASE, signIn } from './helpers/fake-cloud.js'

// Security review of round 1: under `redact`, the value of a credential-named
// key is replaced one-way, so neither the project's map nor a published team
// map ever holds it.

const SRC = 'export function boot(ledgerUser: string) { os.Setenv("DB_PASSWORD", "sunshine") }\n'

let home: string
let cwd: string
let cloud: FakeCloud
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-cvm-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-cvm-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  cloud = new FakeCloud()
  cloud.recordsReservations = true
  vi.stubGlobal('fetch', cloud.fetch)
  signIn(home, { team: true, pmk: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const mapPath = (): string => join(cwd, STORE_DIR, STORE_FILE)
async function run(
  argv: string[],
  stdin = SRC
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => stdin,
    stdinBytes: async function* () {
      yield Buffer.from(stdin)
    },
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => PASSPHRASE,
  }
  return { code: await main(argv, io), out, err }
}

describe('a credential value and the team map', () => {
  it('scrub --team and maps push never put it in the map', async () => {
    const scrubbed = await run(['scrub', '--team'])
    expect(scrubbed.code, scrubbed.err).toBe(EXIT_OK)
    expect(scrubbed.out).toContain('__REDACTED_CREDENTIAL_')
    expect(scrubbed.out).not.toContain('sunshine')
    expect(Object.values(loadMap(mapPath()))).not.toContain('sunshine')

    const pushed = await run(['maps', 'push', '--team', 'mine'])
    expect(pushed.code, pushed.err).toBe(EXIT_OK)
    const id = /as (\S+)/.exec(pushed.out)?.[1] ?? ''
    rmSync(join(cwd, STORE_DIR), { recursive: true, force: true })
    const pulled = await run(['maps', 'pull', id, '--force'])
    expect(pulled.code, pulled.err).toBe(EXIT_OK)
    const published = loadMap(mapPath())
    expect(Object.values(published)).toContain('ledgerUser')
    expect(Object.values(published)).not.toContain('sunshine')
  })
})
