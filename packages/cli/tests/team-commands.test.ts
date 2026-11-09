import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { saveMap, STORE_DIR, STORE_FILE } from '../src/store.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { writeCredential, credentialPath } from '../src/credential.js'
import {
  readTeamUnlock,
  teamUnlockPath,
  writeKeyOf,
  writeTeamUnlock,
  expiryFrom,
} from '../src/team-unlock.js'
import { confirmPin, readPins } from '../src/key-pins.js'
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
  /** A further real wrap to this account, made by a NEW granter key. */
  wrapByNewKey: (version: number) => Promise<{ wrapped_key: string; granterPublic: string }>
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

  async function wrapByNewKey(version: number) {
    const other = (await subtle.generateKey({ name: 'X25519' }, true, [
      'deriveBits',
    ])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey }
    const otherPublic = toBase64(await subtle.exportKey('raw', other.publicKey))
    const key = await deriveWrappingKey(
      other.privateKey as unknown as CryptoKeyLike,
      await importPublicKey(myPublic),
      { teamId: 'team-1', version, granterPublicKey: otherPublic, recipientPublicKey: myPublic }
    )
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = await subtle.encrypt(
      { name: 'AES-GCM', iv },
      key as unknown as CryptoKey,
      buf(crypto.getRandomValues(new Uint8Array(32)))
    )
    return {
      granterPublic: otherPublic,
      wrapped_key: JSON.stringify({
        v: 1,
        iv: toBase64(iv),
        data: toBase64(data),
        from: otherPublic,
      }),
    }
  }

  return {
    teamKeyRaw,
    granterPublic,
    myPublic,
    wrapByNewKey,
    bodies: {
      '/api/auth/me': { user: { id: 'u-me', email: ACCOUNT } },
      '/api/teams/mine': {
        team: {
          id: 'team-1',
          name: 'Zespół',
          members: [
            { user_id: 'u-me', email: ACCOUNT, status: 'active' },
            { user_id: 'u2', email: 'ana@example.test', status: 'active' },
            { user_id: 'u3', email: 'bob@example.test', status: 'removed' },
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
        granter: { id: 'u2', publicKey: granterPublic, label: 'ana@example.test', current: true },
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

  it('a confirmed key of a granter no longer in the team is stored read-only, and says so', async () => {
    signIn()
    const { bodies, granterPublic } = await realGrant()
    const key = bodies['/api/teams/team-1/key'] as { wraps: { wrapped_by: string }[] }
    key.wraps[0]!.wrapped_by = 'u3'
    serve(bodies)
    confirmPin({ instance: INSTANCE, account: ACCOUNT }, 'u3', granterPublic, home)

    const { code, out } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_OK)
    const stored = readTeamUnlock({ instance: INSTANCE, account: ACCOUNT }, home)
    expect(stored?.keys[0]).toMatchObject({
      writable: false,
      granter: { id: 'u3', current: false },
    })
    expect(out).toContain(
      'Team "Zespół": key version 1 was granted by bob@example.test, who is no longer in the team, ' +
        'so Veilio can read with it but will not write under it.'
    )
  })

  it('an unconfirmed key of a granter no longer in the team is read-only, and not offered for confirming', async () => {
    signIn()
    const { bodies } = await realGrant()
    const key = bodies['/api/teams/team-1/key'] as { wraps: { wrapped_by: string }[] }
    key.wraps[0]!.wrapped_by = 'u3'
    serve(bodies)

    const { out } = await run(['team', 'unlock'])

    expect(out).toContain('was granted by bob@example.test, who is no longer in the team')
    expect(out).not.toContain('veilio team trust')
    const stored = readTeamUnlock({ instance: INSTANCE, account: ACCOUNT }, home)
    expect(stored?.keys[0]?.writable).toBe(false)
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
    // The wrap opened; it was refused. Never "grant it again".
    expect(err).not.toContain('none of the team key wraps')
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
    expect(err).not.toContain('none of the team key wraps')
  })

  it('a deleted granter is named as such, read-only, and not offered for confirming', async () => {
    signIn()
    const { bodies, granterPublic } = await realGrant()
    const key = bodies['/api/teams/team-1/key'] as { wraps: { wrapped_by: string }[] }
    key.wraps[0]!.wrapped_by = 'deleted-user'
    serve(bodies)

    const { out } = await run(['team', 'unlock'])

    expect(out).toContain(
      'Team "Zespół": key version 1 was granted by a deleted account, who is no longer in the team, ' +
        'so Veilio can read with it but will not write under it.'
    )
    expect(out).not.toContain('veilio team trust')
    const stored = readTeamUnlock({ instance: INSTANCE, account: ACCOUNT }, home)
    expect(stored?.keys[0]?.granter).toEqual({
      id: null,
      publicKey: granterPublic,
      label: 'a deleted account',
      current: false,
    })
  })

  it('a granter id of __proto__ is judged like any other, and its confirmation is kept', async () => {
    signIn()
    const { bodies, granterPublic } = await realGrant()
    const key = bodies['/api/teams/team-1/key'] as { wraps: { wrapped_by: string }[] }
    key.wraps[0]!.wrapped_by = '__proto__'
    const mine = bodies['/api/teams/mine'] as { team: { members: Record<string, string>[] } }
    mine.team.members.push({ user_id: '__proto__', email: 'proto@example.test', status: 'active' })
    serve(bodies)

    expect((await run(['team', 'unlock'])).code).toBe(EXIT_OK)
    const trusted = await run(['team', 'trust', 'Zespół', await fingerprint(granterPublic)])

    expect(trusted.code, trusted.err).toBe(EXIT_OK)
    expect(
      Object.hasOwn(readPins({ instance: INSTANCE, account: ACCOUNT }, home), '__proto__')
    ).toBe(true)
    expect(readTeamUnlock({ instance: INSTANCE, account: ACCOUNT }, home)?.keys[0]?.writable).toBe(
      true
    )
  })

  it('writes nothing when the member list cannot be read', async () => {
    // Who is on the team decides whether a confirmed key may be written under.
    signIn()
    const { bodies } = await realGrant()
    delete bodies['/api/teams/mine']
    serve(bodies)

    const { code, err } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain(
      "Cloud did not list the team's members, so no team key was judged. Nothing was written."
    )
    expect(existsSync(teamUnlockPath(home))).toBe(false)
  })

  it("writes nothing when the member list is another team's", async () => {
    signIn()
    const { bodies } = await realGrant()
    ;(bodies['/api/teams/mine'] as { team: { id: string } }).team.id = 'team-other'
    serve(bodies)

    const { code } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_ERROR)
    expect(existsSync(teamUnlockPath(home))).toBe(false)
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

  it('a team name starting with a dash is named by id in the command, never read as a flag', async () => {
    signIn()
    const { bodies } = await realGrant()
    ;(bodies['/api/teams/mine'] as { team: { name: string } }).team.name = '-Zespół'
    serve(bodies)

    const { out } = await run(['team', 'unlock'])

    expect(out).toMatch(/run: veilio team trust team-1 [0-9a-f-]{23}\n/)
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

describe('a newer version that was not stored blocks writing under an older one (spec 080 review)', () => {
  const binding = { instance: INSTANCE, account: ACCOUNT }
  const ROW_3 =
    'Not saved: the newest key for team "Zespół" is not confirmed on this device. ' +
    'Run `veilio team unlock` to see who granted it, then `veilio team trust`.'

  /** v1 from ana, confirmed; v2 as `make` sets it up. Unlocked. */
  async function withV2(
    make: (g: Awaited<ReturnType<typeof realGrant>>) => Promise<Record<string, unknown>>
  ): Promise<Awaited<ReturnType<typeof realGrant>>> {
    signIn()
    const g = await realGrant()
    const key = g.bodies['/api/teams/team-1/key'] as { wraps: Record<string, unknown>[] }
    key.wraps.push({ version: 2, created_at: '2026-02-01', ...(await make(g)) })
    serve(g.bodies)
    confirmPin(binding, 'u2', g.granterPublic, home)
    expect((await run(['team', 'unlock'])).code).toBe(EXIT_OK)
    return g
  }

  async function pushTeam(): Promise<Run> {
    mkdirSync(join(cwd, '.git'), { recursive: true })
    saveMap(join(cwd, STORE_DIR, STORE_FILE), { __CLS__1: 'Ledger' }, { force: true })
    const served = fetchMock.getMockImplementation() as (
      u: string,
      i?: RequestInit
    ) => Promise<Response>
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      if (path === '/api/maps/team-envelopes')
        return jsonResponse(200, { maps: [], unreadable: [] })
      if (path === '/api/maps' && init?.method === 'POST') return jsonResponse(201, { id: 'map-9' })
      return served(url, init)
    })
    return run(['maps', 'push', 'shared', '--team'])
  }

  it('v2 a changed key (refused): v1 is stored, and still no write goes under it', async () => {
    await withV2(async (g) => ({ ...(await g.wrapByNewKey(2)), wrapped_by: 'u2' }))
    const stored = readTeamUnlock(binding, home)!
    expect(stored.keys.map((k) => k.version)).toEqual([1])
    expect(stored.blockedVersion).toBe(2)
    const pushed = await pushTeam()
    expect(pushed.code).toBe(EXIT_ERROR)
    expect(pushed.err).toContain(ROW_3)
  })

  it('v2 labelled as this account with another key: the same', async () => {
    await withV2(async (g) => ({ ...(await g.wrapByNewKey(2)), wrapped_by: 'u-me' }))
    expect(readTeamUnlock(binding, home)?.blockedVersion).toBe(2)
    expect((await pushTeam()).err).toContain(ROW_3)
  })

  it('v2 that does not open: the same', async () => {
    await withV2(async () => ({
      wrapped_by: 'u2',
      wrapped_key: JSON.stringify({
        v: 1,
        iv: toBase64(new Uint8Array(12)),
        data: toBase64(new Uint8Array(48)),
        from: toBase64(crypto.getRandomValues(new Uint8Array(32))),
      }),
    }))
    expect(readTeamUnlock(binding, home)?.blockedVersion).toBe(2)
    expect((await pushTeam()).err).toContain(ROW_3)
  })

  it("an offline team trust of v1's granter keeps the block", async () => {
    const g = await withV2(async (g) => ({ ...(await g.wrapByNewKey(2)), wrapped_by: 'u2' }))
    const trusted = await run(['team', 'trust', 'Zespół', await fingerprint(g.granterPublic)])
    expect(trusted.code).toBe(EXIT_OK)
    expect(readTeamUnlock(binding, home)?.blockedVersion).toBe(2)
    expect((await pushTeam()).err).toContain(ROW_3)
  })

  it('every version stored: no block, and the write goes through', async () => {
    signIn()
    const g = await realGrant()
    serve(g.bodies)
    confirmPin(binding, 'u2', g.granterPublic, home)
    await run(['team', 'unlock'])
    expect(readTeamUnlock(binding, home)?.blockedVersion).toBeUndefined()
    const pushed = await pushTeam()
    expect(pushed.code, pushed.err).toBe(EXIT_OK)
  })

  it('a version below the newest that was not stored blocks nothing', () => {
    writeTeamUnlock(
      {
        v: 1,
        instance: INSTANCE,
        account: ACCOUNT,
        teamId: 'team-1',
        expiresAt: expiryFrom(new Date()),
        blockedVersion: 1,
        keys: [
          {
            version: 2,
            key: toBase64(new Uint8Array(32)),
            granter: { id: 'u2', publicKey: 'G' },
            writable: true,
          },
        ],
      },
      home
    )
    const read = readTeamUnlock(binding, home)!
    expect(writeKeyOf(read)?.version).toBe(2)
    expect(writeKeyOf({ ...read, blockedVersion: 2 })?.version).toBe(2)
    expect(writeKeyOf({ ...read, blockedVersion: 3 })).toBeNull()
    expect(writeKeyOf({ ...read, blockedVersion: 'x' as unknown as number })).toBeNull()
  })
})

describe('team trust (spec 080 item 7a)', () => {
  async function unlockedReadOnly(): Promise<{ granterPublic: string; fp: string }> {
    signIn()
    const { bodies, granterPublic } = await realGrant()
    serve(bodies)
    expect((await run(['team', 'unlock'])).code).toBe(EXIT_OK)
    fetchMock.mockClear()
    return { granterPublic, fp: await fingerprint(granterPublic) }
  }
  const binding = { instance: INSTANCE, account: ACCOUNT }

  it('confirms the key with that fingerprint, makes its version writable, and needs no network', async () => {
    const { granterPublic, fp } = await unlockedReadOnly()

    const { code, out } = await run(['team', 'trust', 'Zespół', fp])

    expect(code).toBe(EXIT_OK)
    expect(out).toBe(
      `Confirmed ${fp} for ana@example.test on this device. Team "Zespół" key version 1 can now be used to save maps.\n`
    )
    expect(readTeamUnlock(binding, home)?.keys[0]?.writable).toBe(true)
    expect(readPins(binding, home).u2?.current).toBe(granterPublic)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('takes the fingerprint in any case, with spaces for dashes, and the team by its id', async () => {
    const { fp } = await unlockedReadOnly()

    const { code } = await run(['team', 'trust', 'team-1', fp.toUpperCase().replace(/-/g, ' ')])

    expect(code).toBe(EXIT_OK)
    expect(readTeamUnlock(binding, home)?.keys[0]?.writable).toBe(true)
  })

  it('a fingerprint that matches no stored key changes nothing and says so, exit 1', async () => {
    const { fp } = await unlockedReadOnly()
    const wrong = `${fp.slice(0, -1)}${fp.endsWith('0') ? '1' : '0'}`

    const { code, err } = await run(['team', 'trust', 'Zespół', wrong])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain(
      `No key for team "Zespół" has the fingerprint ${wrong}. Check it for typos; run \`veilio team unlock\` to see the fingerprints offered.`
    )
    expect(readTeamUnlock(binding, home)?.keys[0]?.writable).toBe(false)
    expect(readPins(binding, home)).toEqual({})
  })

  it('another team than the one unlocked matches nothing', async () => {
    const { fp } = await unlockedReadOnly()

    const { code, err } = await run(['team', 'trust', 'Ομάδα', fp])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain(`No key for team "Ομάδα" has the fingerprint ${fp}.`)
    expect(readTeamUnlock(binding, home)?.keys[0]?.writable).toBe(false)
  })

  it('a deleted granter is confirmed under the key itself, and still only reads', async () => {
    signIn()
    const { bodies, granterPublic } = await realGrant()
    const key = bodies['/api/teams/team-1/key'] as { wraps: { wrapped_by: string }[] }
    key.wraps[0]!.wrapped_by = 'deleted-user'
    serve(bodies)
    await run(['team', 'unlock'])

    const { code, out } = await run(['team', 'trust', 'Zespół', await fingerprint(granterPublic)])

    expect(code).toBe(EXIT_OK)
    expect(readPins(binding, home)[`key:${granterPublic}`]?.current).toBe(granterPublic)
    // Confirmed, but a deleted account is on no team: it still only reads.
    expect(out).toContain('was granted by a deleted account, who is no longer in the team')
    expect(readTeamUnlock(binding, home)?.keys[0]?.writable).toBe(false)
  })

  it('nothing stored and Cloud unreachable: row 7, nothing confirmed', async () => {
    signIn()
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const { code, err } = await run(['team', 'trust', 'Zespół', '046ee-6b73d-7baf9-15c9f'])
    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain(
      'No key for team "Zespół" has the fingerprint 046ee-6b73d-7baf9-15c9f. Check it for typos; run `veilio team unlock` to see the fingerprints offered.'
    )
    expect(readPins(binding, home)).toEqual({})
  })

  it("after a confirmed teammate's key changed (row 4), trusting the new fingerprint fetches the wrap again, stores it writable, and a write succeeds", async () => {
    signIn()
    const { bodies, granterPublic, teamKeyRaw } = await realGrant()
    serve(bodies)
    const before = toBase64(crypto.getRandomValues(new Uint8Array(32)))
    confirmPin(binding, 'u2', before, home)
    const unlocked = await run(['team', 'unlock'])
    expect(unlocked.err).toContain("ana@example.test's key changed from")
    expect(existsSync(teamUnlockPath(home))).toBe(false)

    const fp = await fingerprint(granterPublic)
    const { code, out } = await run(['team', 'trust', 'Zespół', fp])

    expect(code).toBe(EXIT_OK)
    expect(out).toContain(
      `Confirmed ${fp} for ana@example.test on this device. Team "Zespół" key version 1 can now be used to save maps.`
    )
    expect(readPins(binding, home).u2).toMatchObject({ current: granterPublic, history: [before] })
    expect(readTeamUnlock(binding, home)?.keys).toMatchObject([
      { version: 1, key: toBase64(teamKeyRaw), writable: true },
    ])

    // And the write the change had stopped now goes through.
    mkdirSync(join(cwd, '.git'), { recursive: true })
    saveMap(join(cwd, STORE_DIR, STORE_FILE), { __CLS__1: 'Ledger' }, { force: true })
    const served = fetchMock.getMockImplementation() as (
      u: string,
      i?: RequestInit
    ) => Promise<Response>
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      if (path === '/api/maps/team-envelopes')
        return jsonResponse(200, { maps: [], unreadable: [] })
      if (path === '/api/maps' && init?.method === 'POST') return jsonResponse(201, { id: 'map-9' })
      return served(url, init)
    })
    const pushed = await run(['maps', 'push', 'shared', '--team'])
    expect(pushed.code, pushed.err).toBe(EXIT_OK)
    expect(pushed.out).toContain('map-9')
  })

  it('a fetched wrap labelled as this account is never confirmed for anyone', async () => {
    signIn()
    const { bodies, granterPublic } = await realGrant()
    const key = bodies['/api/teams/team-1/key'] as { wraps: { wrapped_by: string }[] }
    key.wraps[0]!.wrapped_by = 'u-me'
    serve(bodies)
    await run(['team', 'unlock'])

    const { code, err } = await run(['team', 'trust', 'Zespół', await fingerprint(granterPublic)])

    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain('No key for team "Zespół" has the fingerprint')
    expect(readPins(binding, home)).toEqual({})
  })

  it('needs both the team and the fingerprint', async () => {
    signIn()
    const { code, err } = await run(['team', 'trust', 'Zespół'])
    expect(code).toBe(EXIT_ERROR)
    expect(err).toContain('veilio team trust <team> <fingerprint>')
  })

  it('a confirmed key is trusted by the next unlock too, with nothing to confirm', async () => {
    const { fp } = await unlockedReadOnly()
    await run(['team', 'trust', 'Zespół', fp])

    const { code, out } = await run(['team', 'unlock'])

    expect(code).toBe(EXIT_OK)
    expect(out).not.toContain('veilio team trust')
    expect(readTeamUnlock(binding, home)?.keys[0]?.writable).toBe(true)
  })
})

describe('keys fingerprint (spec 080 item 7a)', () => {
  it("prints the fingerprint of the public key derived from this account's private key", async () => {
    signIn()
    const { bodies, myPublic } = await realGrant()
    serve(bodies)

    const { code, out } = await run(['keys', 'fingerprint'])

    expect(code).toBe(EXIT_OK)
    expect(out).toBe(
      `Your key fingerprint: ${await fingerprint(myPublic)}. Teammates compare this when they confirm a key you granted.\n`
    )
  })

  it("refuses when the server's public key is not this private key's - never shows the server's copy", async () => {
    signIn()
    const { bodies, granterPublic } = await realGrant()
    ;(bodies['/api/auth/keys'] as { publicKey: string }).publicKey = granterPublic
    serve(bodies)

    const { code, out, err } = await run(['keys', 'fingerprint'])

    expect(code).toBe(EXIT_ERROR)
    expect(out).toBe('')
    expect(err).toContain('does not belong to its private key')
  })

  it('a wrong passphrase prints no fingerprint', async () => {
    signIn()
    const { bodies } = await realGrant()
    serve(bodies)

    const { code, out } = await run(['keys', 'fingerprint'], 'not-the-passphrase')

    expect(code).toBe(EXIT_ERROR)
    expect(out).toBe('')
  })

  it('refuses when not signed in, without reaching the network', async () => {
    const { code } = await run(['keys', 'fingerprint'])
    expect(code).toBe(EXIT_ERROR)
    expect(fetchMock).not.toHaveBeenCalled()
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
