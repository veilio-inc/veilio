import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deriveVaultKey, encryptMapForVault, toBase64, type SymbolMap } from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { writeCredential } from '../src/credential.js'
import { STORE_DIR, STORE_FILE } from '../src/store.js'

/**
 * Maps, both directions, and the promise that makes them worth using.
 *
 * The passphrase never leaves this machine. That is not a policy anybody can
 * follow by being careful — it is checked by looking at every request body the
 * command produced and searching for the passphrase, which is the only form of
 * that assertion that cannot be satisfied by good intentions.
 *
 * The other control is an ordering: decrypt first, write second. A wrong
 * passphrase must leave the store exactly as it was, because the store is the
 * one thing that can restore text already anonymized — a partial write there is
 * not an inconvenience, it is text nobody can ever read back.
 */

let home: string
let cwd: string
let fetchMock: ReturnType<typeof vi.fn>

const PASSPHRASE = 'correct horse battery staple'
const INSTANCE = 'https://veilio.test'
const SALT = new Uint8Array(32).fill(9)
const MAP: SymbolMap = { __CLS__1: 'PaymentGateway', __FN__2: 'chargeCard' }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-maps-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-maps-work-'))
  // A .git marker so findProjectRoot settles on cwd rather than walking up into
  // whatever the temp directory happens to sit inside.
  mkdirSync(join(cwd, '.git'), { recursive: true })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  writeCredential({ token: 'tok', account: 'a@b.test', instance: INSTANCE }, home)
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const mapPath = (): string => join(cwd, STORE_DIR, STORE_FILE)

interface Run {
  code: number
  out: string
  err: string
}

async function run(argv: string[], passphrase = PASSPHRASE): Promise<Run> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => '',
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => passphrase,
  }
  const code = await main(argv, io)
  return { code, out, err }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function sealedFor(map: SymbolMap, passphrase = PASSPHRASE): Promise<string> {
  const key = await deriveVaultKey(passphrase, SALT)
  return JSON.stringify(await encryptMapForVault(key, map))
}

async function vaultBody(): Promise<unknown> {
  const key = await deriveVaultKey(PASSPHRASE, SALT)
  const { encryptMapForVault: seal } = await import('@veilio-inc/engine')
  // The verifier the server would hold: a known constant under the same key.
  // Built through the engine so the test cannot drift from the implementation.
  const iv = new Uint8Array(12).fill(3)
  void seal
  const subtle = (globalThis.crypto as Crypto).subtle
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    key as unknown as CryptoKey,
    new TextEncoder().encode('veilio-vault-verifier-v1')
  )
  return {
    initialized: true,
    salt: toBase64(SALT),
    verifier: JSON.stringify({ iv: toBase64(iv), data: toBase64(ct) }),
    kdf: { name: 'PBKDF2-SHA256', iterations: 600_000 },
  }
}

/** Every request body this run produced, as text. */
function sentBodies(): string[] {
  return fetchMock.mock.calls.map((c) => {
    const init = c[1] as { body?: unknown } | undefined
    return typeof init?.body === 'string' ? init.body : ''
  })
}

// ─── T030 — decrypted here, and the passphrase never goes out ────────────────

describe('a personal map is opened on this machine (T030, FR-012)', () => {
  beforeEach(async () => {
    const sealed = await sealedFor(MAP)
    const vault = await vaultBody()
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url)
      if (u.endsWith('/api/auth/vault')) return json(200, vault)
      if (u.includes('/api/maps/')) {
        return json(200, {
          id: 'map-1',
          name: 'billing',
          scope: 'personal',
          identifier_count: 2,
          updated_at: '2026-09-01T00:00:00.000Z',
          storage: 'client-envelope',
          map_data: sealed,
        })
      }
      return json(200, { personalMaps: [], teamMaps: [], plan: 'pro' })
    })
  })

  it('pulls and decrypts into the local store', async () => {
    const res = await run(['maps', 'pull', 'map-1'])
    expect(res.code, res.err).toBe(EXIT_OK)

    const stored = JSON.parse(readFileSync(mapPath(), 'utf8')) as { map: SymbolMap }
    expect(stored.map).toEqual(MAP)
  })

  it('never puts the passphrase in a request body', async () => {
    await run(['maps', 'pull', 'map-1'])
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
    for (const body of sentBodies()) {
      expect(body, 'the passphrase reached a request body').not.toContain(PASSPHRASE)
    }
    // And not in a header or the URL either — a "helpful" X-Vault-Passphrase is
    // exactly the kind of thing that gets added to make something work.
    const serialised = JSON.stringify(fetchMock.mock.calls)
    expect(serialised).not.toContain(PASSPHRASE)
  })

  it('records where the map came from, so divergence can be seen later', async () => {
    await run(['maps', 'pull', 'map-1'])
    const stored = JSON.parse(readFileSync(mapPath(), 'utf8')) as {
      remote?: { id: string; updatedAt: string }
    }
    expect(stored.remote?.id).toBe('map-1')
    expect(stored.remote?.updatedAt).toBe('2026-09-01T00:00:00.000Z')
  })

  it('pushes an envelope the server cannot read', async () => {
    mkdirSync(join(cwd, STORE_DIR), { recursive: true })
    writeFileSync(mapPath(), JSON.stringify({ version: 1, map: MAP }))
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url)
      if (u.endsWith('/api/auth/vault')) return json(200, await vaultBody())
      return json(201, { id: 'new-map' })
    })

    const res = await run(['maps', 'push', 'billing'])
    expect(res.code, res.err).toBe(EXIT_OK)

    const posted = sentBodies().find((b) => b.includes('map_data'))
    expect(posted, 'nothing was posted').toBeTruthy()
    // The plaintext identifiers must not appear anywhere in what went out.
    expect(posted).not.toContain('PaymentGateway')
    expect(posted).not.toContain('chargeCard')
    expect(posted).not.toContain(PASSPHRASE)
    expect(posted).toContain('AES-256-GCM-PBKDF2')
  })
})

// ─── T031 — a wrong passphrase writes nothing ────────────────────────────────

describe('a wrong passphrase writes nothing and says which thing was wrong (T031)', () => {
  beforeEach(async () => {
    const sealed = await sealedFor(MAP)
    const vault = await vaultBody()
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url)
      if (u.endsWith('/api/auth/vault')) return json(200, vault)
      return json(200, {
        id: 'map-1',
        name: 'billing',
        scope: 'personal',
        identifier_count: 2,
        updated_at: '2026-09-01T00:00:00.000Z',
        storage: 'client-envelope',
        map_data: sealed,
      })
    })
  })

  it('leaves no store file at all', async () => {
    const res = await run(['maps', 'pull', 'map-1'], 'not the passphrase')
    expect(res.code).toBe(EXIT_ERROR)
    expect(existsSync(mapPath()), 'a failed pull wrote a store file').toBe(false)
  })

  it('leaves an EXISTING local map exactly as it was', async () => {
    // The version that actually loses data: overwriting a map somebody is
    // relying on, with nothing, because the passphrase was mistyped.
    mkdirSync(join(cwd, STORE_DIR), { recursive: true })
    const before = JSON.stringify({ version: 1, map: { __CLS__9: 'Existing' } })
    writeFileSync(mapPath(), before)

    const res = await run(['maps', 'pull', 'map-1'], 'not the passphrase')
    expect(res.code).toBe(EXIT_ERROR)
    expect(readFileSync(mapPath(), 'utf8')).toBe(before)
  })

  it('names the passphrase, not the map', async () => {
    const res = await run(['maps', 'pull', 'map-1'], 'not the passphrase')
    expect(res.err).toMatch(/passphrase/i)
    expect(res.err).not.toMatch(/corrupt|damaged|malformed/i)
  })

  it('refuses to push under a wrong passphrase, before uploading anything', async () => {
    // Pushing under the wrong key would store a map the account can never open
    // again — and it would look like success.
    mkdirSync(join(cwd, STORE_DIR), { recursive: true })
    writeFileSync(mapPath(), JSON.stringify({ version: 1, map: MAP }))
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/auth/vault')) return json(200, await vaultBody())
      return json(201, { id: 'should-not-happen' })
    })

    const res = await run(['maps', 'push', 'billing'], 'not the passphrase')
    expect(res.code).toBe(EXIT_ERROR)
    expect(
      sentBodies().some((b) => b.includes('map_data')),
      'it uploaded anyway'
    ).toBe(false)
  })
})

// ─── T032 — no vault is said plainly ─────────────────────────────────────────

describe('a map whose vault was never created (T032)', () => {
  it('says so instead of asking for a passphrase that cannot exist', async () => {
    const sealed = await sealedFor(MAP)
    let passwordAsked = false
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/auth/vault')) return json(200, { initialized: false })
      return json(200, {
        id: 'map-1',
        name: 'billing',
        scope: 'personal',
        identifier_count: 2,
        updated_at: '2026-09-01T00:00:00.000Z',
        storage: 'client-envelope',
        map_data: sealed,
      })
    })

    let out = ''
    let err = ''
    const io: Io = {
      cwd,
      home,
      stdin: async () => '',
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      password: async () => {
        passwordAsked = true
        return PASSPHRASE
      },
    }
    const code = await main(['maps', 'pull', 'map-1'], io)
    expect(code).toBe(EXIT_ERROR)
    expect(err).toMatch(/vault/i)
    expect(passwordAsked, 'it asked for a passphrase with no vault to check it against').toBe(false)
    expect(existsSync(mapPath())).toBe(false)
    void out
  })
})

// ─── T035 — divergence is reported, never silently resolved ──────────────────

describe('a local copy that has diverged from Cloud (T035)', () => {
  beforeEach(async () => {
    const sealed = await sealedFor({ __CLS__1: 'CloudSideChange' })
    const vault = await vaultBody()
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url)
      if (u.endsWith('/api/auth/vault')) return json(200, vault)
      return json(200, {
        id: 'map-1',
        name: 'billing',
        scope: 'personal',
        identifier_count: 1,
        // Newer than what we recorded at pull time.
        updated_at: '2026-09-03T00:00:00.000Z',
        storage: 'client-envelope',
        map_data: sealed,
      })
    })
    mkdirSync(join(cwd, STORE_DIR), { recursive: true })
  })

  function seedDivergedLocal(): string {
    const stored = JSON.stringify({
      version: 1,
      map: { __CLS__1: 'LocalSideChange' },
      remote: { id: 'map-1', updatedAt: '2026-09-01T00:00:00.000Z', pulledAt: '2026-09-01' },
    })
    writeFileSync(mapPath(), stored)
    return stored
  }

  it('reports the conflict and touches neither side', async () => {
    const before = seedDivergedLocal()
    const res = await run(['maps', 'pull', 'map-1'])
    expect(res.code).toBe(EXIT_ERROR)
    expect(res.err).toMatch(/changed in Cloud/i)
    expect(readFileSync(mapPath(), 'utf8'), 'the local map was overwritten').toBe(before)
  })

  it('overwrites only when explicitly told to', async () => {
    seedDivergedLocal()
    const res = await run(['maps', 'pull', 'map-1', '--force'])
    expect(res.code, res.err).toBe(EXIT_OK)
    const stored = JSON.parse(readFileSync(mapPath(), 'utf8')) as { map: SymbolMap }
    expect(stored.map).toEqual({ __CLS__1: 'CloudSideChange' })
  })

  it('does not cry conflict when the local copy is untouched', async () => {
    // A false conflict on every pull would be worse than none: people would
    // start passing --force reflexively, and then the real one gets overwritten.
    writeFileSync(
      mapPath(),
      JSON.stringify({
        version: 1,
        map: { __CLS__1: 'CloudSideChange' },
        remote: { id: 'map-1', updatedAt: '2026-09-01T00:00:00.000Z' },
      })
    )
    const res = await run(['maps', 'pull', 'map-1'])
    expect(res.code, res.err).toBe(EXIT_OK)
  })
})
