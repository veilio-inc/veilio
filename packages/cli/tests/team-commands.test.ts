import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { writeCredential, credentialPath } from '../src/credential.js'
import { readTeamUnlock, teamUnlockPath, writeTeamUnlock, expiryFrom } from '../src/team-unlock.js'
import { confirmPin } from '../src/key-pins.js'
import { fingerprint } from '../src/client/fingerprint.js'
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
    stdinBytes: async function* () {
      yield Buffer.from('')
    },
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
async function realGrant(): Promise<{
  bodies: Record<string, unknown>
  teamKeyRaw: Uint8Array
  granterPublic: string
  myPublic: string
}> {
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
    granterPublic,
    myPublic,
    bodies: {
      '/api/auth/me': { user: { id: 'u-me', email: ACCOUNT } },
      '/api/teams/mine': {
        team: {
          id: 'team-1',
          name: 'Zespół',
          members: [
            { user_id: 'u-me', email: ACCOUNT, status: 'active' },
            { user_id: 'u2', email: 'ana@example.test', status: 'active' },
          ],
        },
      },
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
    expect(stored?.keys).toMatchObject([{ version: 1, key: toBase64(teamKeyRaw) }])
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

  it('says a team member still has to grant access, once the server says the team has a key', async () => {
    // Holding no wrap now first tries to mint the team's first key (spec 052).
    // The server refuses - the team has one, held by others - so this stands
    // down and says who can grant it.
    signIn()
    const { bodies } = await realGrant()
    serve({
      ...bodies,
      '/api/teams/team-1/key': { wraps: [], granted: false },
      '/api/auth/me': { user: { id: 'u-me', email: ACCOUNT } },
      '/api/teams/team-1/key/pending': { version: 1, nextVersion: 2 },
    })
    const served = fetchMock.getMockImplementation() as (
      url: string,
      init?: RequestInit
    ) => Promise<Response>
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      new URL(String(url)).pathname === '/api/teams/team-1/key/grant'
        ? jsonResponse(403, { error: 'You do not hold that version of the team key' })
        : served(url, init)
    )

    const { code, err } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain('granted this account the team key')
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

describe('team unlock judges who granted each key (spec 080 item 7a)', () => {
  it('a key wrapped with a key nobody confirmed - as a server-minted wrap is - is stored read-only, and says how to confirm it', async () => {
    signIn()
    const { bodies, teamKeyRaw, granterPublic } = await realGrant()
    serve(bodies)

    const { code, out } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_OK)
    const stored = readTeamUnlock({ instance: INSTANCE, account: ACCOUNT }, home)
    expect(stored?.keys).toEqual([
      {
        version: 1,
        key: toBase64(teamKeyRaw),
        granter: { id: 'u2', publicKey: granterPublic },
        writable: false,
      },
    ])
    expect(stored?.teamName).toBe('Zespół')
    const fp = await fingerprint(granterPublic)
    expect(out).toContain(
      `Team "Zespół": key version 1 was granted by ana@example.test with key ${fp}. ` +
        'You have not confirmed this key on this device, so Veilio can read with it but will not write under it. ' +
        'Ask ana@example.test for the key fingerprint Veilio shows them on their dashboard under "Your key fingerprint", ' +
        `and if it matches, run: veilio team trust Zespół ${fp}`
    )
  })

  it('a key from a granter whose key this device confirmed is stored writable, with nothing to confirm', async () => {
    signIn()
    const { bodies, granterPublic } = await realGrant()
    serve(bodies)
    confirmPin({ instance: INSTANCE, account: ACCOUNT }, 'u2', granterPublic, home)

    const { code, out } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_OK)
    const stored = readTeamUnlock({ instance: INSTANCE, account: ACCOUNT }, home)
    expect(stored?.keys[0]).toMatchObject({ writable: true, granter: { id: 'u2' } })
    expect(out).not.toContain('veilio team trust')
  })

  it("a confirmed granter's key that changed is not stored, and says to compare before trusting it", async () => {
    signIn()
    const { bodies, granterPublic } = await realGrant()
    serve(bodies)
    const before = toBase64(crypto.getRandomValues(new Uint8Array(32)))
    confirmPin({ instance: INSTANCE, account: ACCOUNT }, 'u2', before, home)

    const { code, err } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_ERROR)
    expect(existsSync(teamUnlockPath(home))).toBe(false)
    expect(err).toContain(
      `Team "Zespół": ana@example.test's key changed from ${await fingerprint(before)} to ${await fingerprint(granterPublic)}. ` +
        'This happens when they reset their key - or when someone else is posing as them. ' +
        'Compare the new fingerprint with ana@example.test before you run `veilio team trust`. ' +
        'Until then nothing is written under this key.'
    )
  })

  it('a wrap labelled as this account but made with another key is not stored, and says whom to tell', async () => {
    signIn()
    const { bodies } = await realGrant()
    const key = bodies['/api/teams/team-1/key'] as { wraps: { wrapped_by: string }[] }
    key.wraps[0]!.wrapped_by = 'u-me'
    serve(bodies)

    const { code, err } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_ERROR)
    expect(existsSync(teamUnlockPath(home))).toBe(false)
    expect(err).toContain(
      'Team "Zespół": key version 1 claims to come from your own key but does not. It was not stored. ' +
        'Tell your team administrator and support@veilio.dev.'
    )
  })

  it('a deleted granter is named as such and confirmed under the key itself', async () => {
    signIn()
    const { bodies, granterPublic } = await realGrant()
    const key = bodies['/api/teams/team-1/key'] as { wraps: { wrapped_by: string }[] }
    key.wraps[0]!.wrapped_by = 'deleted-user'
    serve(bodies)

    const { out } = await run(['team', 'unlock'])

    expect(out).toContain('was granted by a deleted account with key')
    const stored = readTeamUnlock({ instance: INSTANCE, account: ACCOUNT }, home)
    expect(stored?.keys[0]?.granter).toEqual({ id: null, publicKey: granterPublic })
  })

  it('without the member list, names the team and granter by id, and still judges', async () => {
    signIn()
    const { bodies } = await realGrant()
    delete bodies['/api/teams/mine']
    serve(bodies)

    const { code, out } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_OK)
    expect(out).toContain('Team "team-1": key version 1 was granted by u2 with key')
    expect(out).toContain('veilio team trust team-1 ')
  })

  it("never prints the server's control, bidi or zero-width characters, and never puts them in the command to copy", async () => {
    signIn()
    const { bodies } = await realGrant()
    const hostile = 'Zesp\u001b[2J\u202eół\u200b'
    const mine = bodies['/api/teams/mine'] as {
      team: { name: string; members: { user_id: string; email: string }[] }
    }
    mine.team.name = hostile
    mine.team.members[1]!.email = 'ana\u001b]0;x\u0007@ex\u2066ample.test\u200f'
    serve(bodies)

    const { code, out } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_OK)
    // eslint-disable-next-line no-control-regex -- matching them is the point
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}]/u)
    expect(out).toContain('Team "Zesp?[2J?ół?"')
    expect(out).toContain('was granted by ana?]0;x?@ex?ample.test? with key')
    // Not one shell word of letters and digits: the command names the team by id.
    expect(out).toMatch(/run: veilio team trust team-1 [0-9a-f-]{23}\n/)
    // The stored name is the cleaned one, so a later refusal prints it safely too.
    expect(readTeamUnlock({ instance: INSTANCE, account: ACCOUNT }, home)?.teamName).toBe(
      'Zesp?[2J?ół?'
    )
  })

  it('names the team by its name in the command when that name is letters, digits, dot, dash or underscore', async () => {
    signIn()
    const { bodies } = await realGrant()
    ;(bodies['/api/teams/mine'] as { team: { name: string } }).team.name = 'Ομάδα_Kraków-2.0'
    serve(bodies)

    const { out } = await run(['team', 'unlock'])

    expect(out).toMatch(/run: veilio team trust Ομάδα_Kraków-2\.0 [0-9a-f-]{23}\n/)
  })

  it('writes nothing when Cloud does not say which account this is', async () => {
    signIn()
    const { bodies } = await realGrant()
    serve({ ...bodies, '/api/auth/me': { user: {} } })

    const { code } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_ERROR)
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
        keys: [
          {
            version: 1,
            key: toBase64(new Uint8Array(32)),
            granter: { id: 'u-granter', publicKey: 'GRANTER' },
            writable: true,
          },
        ],
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
        keys: [
          {
            version: 1,
            key: toBase64(new Uint8Array(32)),
            granter: { id: 'u-granter', publicKey: 'GRANTER' },
            writable: true,
          },
        ],
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
