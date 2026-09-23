import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { writeCredential, credentialPath } from '../src/credential.js'
import { readTeamUnlock, teamUnlockPath, writeTeamUnlock, expiryFrom } from '../src/team-unlock.js'
import {
  toBase64,
  deriveVaultKey,
  randomVaultSalt,
  deriveWrappingKey,
  importPublicKey,
  type CryptoKeyLike,
} from '@veilio-inc/engine'

/**
 * `veilio team unlock` and `veilio team lock`.
 *
 * Unlock is the interactive half of the team namespace: a terminal where
 * somebody is present types the passphrase, and what it leaves behind is what
 * an MCP server — which has nobody to ask — reads later.
 *
 * The orderings that matter here are the same shape as `logout`'s: this writes
 * key material only after the passphrase has been proved right, and `logout`
 * removes that material BEFORE the credential. Both fail in a direction nobody
 * notices, so both have a test that fails when swapped.
 */

let home: string
let cwd: string
let fetchMock: ReturnType<typeof vi.fn>

const INSTANCE = 'https://veilio.test'
const ACCOUNT = 'user@example.test'
const PASSPHRASE = 'CorrectHorseBattery123'

const subtle = globalThis.crypto.subtle
const buf = (u: Uint8Array) => u as unknown as Uint8Array<ArrayBuffer>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-work-'))
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

interface Run {
  code: number
  out: string
  err: string
}

async function run(argv: string[], password = PASSPHRASE): Promise<Run> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => '',
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => ACCOUNT,
    password: async () => password,
  }
  const code = await main(argv, io)
  return { code, out, err }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function signIn(): void {
  writeCredential({ token: 'session-token', account: ACCOUNT, instance: INSTANCE }, home)
}

/**
 * A real vault, keypair and team-key grant, built the way the browser builds
 * them — so `unlock` runs its actual crypto rather than a stand-in.
 */
async function realGrant(): Promise<{ bodies: Record<string, unknown>; teamKeyRaw: Uint8Array }> {
  const salt = randomVaultSalt()
  const vaultKey = await deriveVaultKey(PASSPHRASE, salt)
  const verifier = await makeVerifier(vaultKey)

  const me = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as unknown as {
    publicKey: CryptoKey
    privateKey: CryptoKey
  }
  const granter = (await subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey }

  const myPublic = toBase64(await subtle.exportKey('raw', me.publicKey))
  const granterPublic = toBase64(await subtle.exportKey('raw', granter.publicKey))

  // The private half, wrapped under the vault key.
  const pkcs8 = await subtle.exportKey('pkcs8', me.privateKey)
  const privIv = crypto.getRandomValues(new Uint8Array(12))
  const privData = await subtle.encrypt(
    { name: 'AES-GCM', iv: privIv },
    vaultKey as unknown as CryptoKey,
    pkcs8
  )
  const privateKeyEncrypted = JSON.stringify({
    v: 1,
    alg: 'AES-GCM',
    iv: toBase64(privIv),
    data: toBase64(privData),
  })

  // The team key, wrapped to my public key by a teammate.
  const teamKeyRaw = crypto.getRandomValues(new Uint8Array(32))
  const wrappingKey = await deriveWrappingKey(
    granter.privateKey as unknown as CryptoKeyLike,
    await importPublicKey(myPublic),
    {
      teamId: 'team-1',
      version: 1,
      granterPublicKey: granterPublic,
      recipientPublicKey: myPublic,
    }
  )
  const wrapIv = crypto.getRandomValues(new Uint8Array(12))
  const wrapData = await subtle.encrypt(
    { name: 'AES-GCM', iv: wrapIv },
    wrappingKey as unknown as CryptoKey,
    buf(teamKeyRaw)
  )
  const wrapped_key = JSON.stringify({
    v: 1,
    iv: toBase64(wrapIv),
    data: toBase64(wrapData),
    from: granterPublic,
  })

  return {
    teamKeyRaw,
    bodies: {
      '/api/maps': { personalMaps: [], teamMaps: [], team: { id: 'team-1' }, plan: 'team' },
      '/api/auth/keys': {
        initialized: true,
        publicKey: myPublic,
        privateKeyEncrypted,
        alg: 'X25519',
      },
      '/api/teams/team-1/key': {
        wraps: [{ version: 1, wrapped_key, wrapped_by: 'u2', created_at: '2026-01-01' }],
        granted: true,
      },
      '/api/auth/vault': { initialized: true, salt: toBase64(salt), verifier },
    },
  }
}

/** The verifier the vault uses to say "right passphrase" before decrypting. */
async function makeVerifier(vaultKey: CryptoKeyLike): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    vaultKey as unknown as CryptoKey,
    new TextEncoder().encode('veilio-vault-verifier-v1')
  )
  return JSON.stringify({ v: 1, iv: toBase64(iv), data: toBase64(data) })
}

function serve(bodies: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(String(url)).pathname
    if (path in bodies) return jsonResponse(200, bodies[path])
    return jsonResponse(404, { error: 'not found' })
  })
}

describe('team unlock', () => {
  it('stores the team key after proving the passphrase, readable only by this user', async () => {
    signIn()
    const { bodies, teamKeyRaw } = await realGrant()
    serve(bodies)

    const { code, out } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_OK)
    expect(out).toContain('Unlocked')
    expect(statSync(teamUnlockPath(home)).mode & 0o777).toBe(0o600)

    // The key stored is the one the teammate wrapped, recovered through the
    // real three-step unwrap rather than copied from anywhere.
    const stored = readTeamUnlock({ instance: INSTANCE, account: ACCOUNT }, home)
    expect(stored?.teamId).toBe('team-1')
    expect(stored?.keys).toEqual([{ version: 1, key: toBase64(teamKeyRaw) }])
  })

  it('writes nothing when the passphrase is wrong', async () => {
    // Proved against the verifier first, so a wrong passphrase is named as one
    // rather than surfacing later as an authentication-tag failure.
    signIn()
    const { bodies } = await realGrant()
    serve(bodies)

    const { code, err } = await run(['team', 'unlock'], 'not-the-passphrase')

    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain('not right')
    expect(err).toContain('Nothing was written')
    expect(existsSync(teamUnlockPath(home))).toBe(false)
  })

  it('refuses when not signed in, without reaching the network', async () => {
    const { code, err } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain('not signed in')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says so when the account is in no team', async () => {
    signIn()
    serve({ '/api/maps': { personalMaps: [], teamMaps: [], team: null, plan: 'individual' } })

    const { code, err } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain('not in a team')
    expect(existsSync(teamUnlockPath(home))).toBe(false)
  })

  it('points at the web app when the account has no keypair', async () => {
    signIn()
    const { bodies } = await realGrant()
    serve({ ...bodies, '/api/auth/keys': { initialized: false } })

    const { code, err } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain('no keypair')
    expect(existsSync(teamUnlockPath(home))).toBe(false)
  })

  it('says a teammate still has to grant access', async () => {
    signIn()
    const { bodies } = await realGrant()
    serve({ ...bodies, '/api/teams/team-1/key': { wraps: [], granted: false } })

    const { code, err } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain('granted you the team key')
    expect(existsSync(teamUnlockPath(home))).toBe(false)
  })

  it('reports when no held wrap can be opened, rather than writing an empty unlock', async () => {
    // A wrap addressed to a key this account no longer has. Writing an unlock
    // with zero keys would read back as "unlocked" and open nothing.
    signIn()
    const { bodies } = await realGrant()
    const foreign = JSON.stringify({
      v: 1,
      iv: toBase64(new Uint8Array(12)),
      data: toBase64(new Uint8Array(48)),
      from: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    })
    serve({
      ...bodies,
      '/api/teams/team-1/key': {
        wraps: [{ version: 1, wrapped_key: foreign, wrapped_by: 'u2', created_at: '2026-01-01' }],
        granted: true,
      },
    })

    const { code, err } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain('none of the team key wraps')
    expect(existsSync(teamUnlockPath(home))).toBe(false)
  })
})

describe('team lock', () => {
  it('removes the stored keys', async () => {
    signIn()
    writeTeamUnlock(
      {
        v: 1,
        instance: INSTANCE,
        account: ACCOUNT,
        teamId: 'team-1',
        expiresAt: expiryFrom(new Date()),
        keys: [{ version: 1, key: toBase64(new Uint8Array(32)) }],
      },
      home
    )

    const { code, out } = await run(['team', 'lock'])

    expect(code).toBe(EXIT_OK)
    expect(out).toContain('locked')
    expect(existsSync(teamUnlockPath(home))).toBe(false)
  })

  it('says there was nothing to remove, and exits cleanly', async () => {
    const { code, out } = await run(['team', 'lock'])

    expect(code).toBe(EXIT_OK)
    expect(out).toContain('No team keys were unlocked')
  })

  it('needs no network and no sign-in', async () => {
    await run(['team', 'lock'])

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('logout takes the team keys with it', () => {
  function unlockOnDisk(): void {
    writeTeamUnlock(
      {
        v: 1,
        instance: INSTANCE,
        account: ACCOUNT,
        teamId: 'team-1',
        expiresAt: expiryFrom(new Date()),
        keys: [{ version: 1, key: toBase64(new Uint8Array(32)) }],
      },
      home
    )
  }

  it('removes them along with the credential', async () => {
    // Signing out while the team's maps stay readable on disk is exactly the
    // gap between what a person believes they gave up and what is still there.
    signIn()
    unlockOnDisk()
    fetchMock.mockImplementation(async () => jsonResponse(200, {}))

    const { code } = await run(['logout'])

    expect(code).toBe(EXIT_OK)
    expect(existsSync(teamUnlockPath(home))).toBe(false)
    expect(existsSync(credentialPath(home))).toBe(false)
  })

  it('removes them even when the session was already revoked', async () => {
    // The server-side state is what logout wanted, so finishing locally is
    // correct — and "locally" has to include the key material.
    signIn()
    unlockOnDisk()
    fetchMock.mockImplementation(async () => jsonResponse(401, { error: 'unauthenticated' }))

    const { code } = await run(['logout'])

    expect(code).toBe(EXIT_OK)
    expect(existsSync(teamUnlockPath(home))).toBe(false)
  })

  it('keeps them when the session could not be revoked, because the user is still signed in', async () => {
    // logout refuses to half-finish: the credential is kept so the user can try
    // again, and the keys belong to that same still-live session.
    signIn()
    unlockOnDisk()
    fetchMock.mockImplementation(async () => jsonResponse(500, { error: 'boom' }))

    const { code } = await run(['logout'])

    expect(code).toBe(EXIT_ERROR)
    expect(existsSync(teamUnlockPath(home))).toBe(true)
    expect(existsSync(credentialPath(home))).toBe(true)
  })
})
