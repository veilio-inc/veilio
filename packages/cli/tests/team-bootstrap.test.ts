import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  deriveWrappingKey,
  exportTeamKey,
  importPublicKey,
  toBase64,
  unwrapTeamKey,
  type CryptoKeyLike,
} from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK } from '../src/commands.js'
import { readTeamUnlock, teamUnlockPath } from '../src/team-unlock.js'
import { wrapTeamKeyFor } from '../src/client/team-key-bootstrap.js'
import { FakeCloud, INSTANCE, ME, PASSPHRASE, TEAM_ID, signIn } from './helpers/fake-cloud.js'

/**
 * The team's FIRST key, minted from the terminal (spec 052 FR-016; found on
 * staging 2026-10-26 by a solo developer with a team of one).
 *
 * A team of one has no key until somebody mints it, and no teammate who ever
 * will: `team unlock` told bill-b to ask a teammate, and nothing could ever
 * publish a team map. So `team unlock`, holding the vault key, bootstraps the
 * key exactly as the web app does (bootstrapTeamKey.ts): a fresh team key,
 * wrapped to the account's own public key, posted as the next version. The
 * SERVER decides whether it really is a bootstrap; a refusal means the team
 * already has a key, and this stands down rather than mint a rival.
 */

let home: string
let cloud: FakeCloud
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'veilio-bootstrap-'))
  cloud = new FakeCloud()
  await cloud.withVault()
  vi.stubGlobal('fetch', cloud.fetch)
  signIn(home)
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
})

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await main(argv, {
    cwd: home,
    home,
    stdin: async () => '',
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    password: async () => PASSPHRASE,
  })
  return { code, out, err }
}

const grants = (): number =>
  cloud.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/key/grant')).length

describe('a team with no key yet', () => {
  it('team unlock mints it, wrapped to this account, and unlocks it', async () => {
    await cloud.withKeypair()
    const r = await run(['team', 'unlock'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(grants()).toBe(1)
    const post = cloud.requests.find((x) => x.path.endsWith('/key/grant'))!
    expect(post.body).toMatchObject({ userId: 'u-me', version: 1 })
    expect(cloud.wraps).toHaveLength(1)
    // The wrap opens with this account's private key, through the engine's
    // own unwrap (the one the browser's format is pinned against).
    const teamKey = await unwrapTeamKey(
      cloud.wraps[0]!.wrapped_key,
      cloud.keypair!.privateKey as unknown as CryptoKeyLike,
      { teamId: TEAM_ID, version: 1, myPublicKey: cloud.keypair!.publicKey }
    )
    // And it is the key that was unlocked here.
    const unlock = readTeamUnlock({ instance: INSTANCE, account: ME }, home)!
    expect(unlock.keys).toEqual([{ version: 1, key: await exportTeamKey(teamKey) }])
    expect(r.out).toMatch(/set up the team key/i)
    // Nothing about teammates: there are none to speak of.
    expect(r.out + r.err).not.toMatch(/teammate/i)
  })

  it('the next unused version, not always 1: a departed holder’s number is never reused', async () => {
    await cloud.withKeypair()
    cloud.usedVersions = 3
    const r = await run(['team', 'unlock'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(cloud.wraps[0]!.version).toBe(4)
  })

  it('the wrap is the browser’s format: {v, iv, data, from}, from this account’s own public key', async () => {
    await cloud.withKeypair()
    await run(['team', 'unlock'])
    const wrap = JSON.parse(cloud.wraps[0]!.wrapped_key) as Record<string, unknown>
    expect(Object.keys(wrap)).toEqual(['v', 'iv', 'data', 'from'])
    expect(wrap.v).toBe(1)
    expect(wrap.from).toBe(cloud.keypair!.publicKey)
  })

  it('cross-check vector: the same bytes as ECDH + HKDF + AES-GCM built by hand', async () => {
    await cloud.withKeypair()
    const priv = cloud.keypair!.privateKey as unknown as CryptoKeyLike
    const pub = cloud.keypair!.publicKey
    const teamRaw = new Uint8Array(32).fill(6)
    const iv = new Uint8Array(12).fill(9)
    const ours = await wrapTeamKeyFor(teamRaw, priv, pub, pub, { teamId: 'team-x', version: 2 }, iv)
    // Built here with the engine's key derivation and WebCrypto directly.
    const wrapping = await deriveWrappingKey(priv, await importPublicKey(pub), {
      teamId: 'team-x',
      version: 2,
      granterPublicKey: pub,
      recipientPublicKey: pub,
    })
    const data = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      wrapping as unknown as CryptoKey,
      teamRaw
    )
    expect(ours).toBe(JSON.stringify({ v: 1, iv: toBase64(iv), data: toBase64(data), from: pub }))
  })
})

describe('a server that lies about this account’s public key (security review)', () => {
  it('is refused before anything is minted or posted: the key is checked against the private key', async () => {
    await cloud.withKeypair()
    // The server hands back ITS OWN public key, hoping to be wrapped to.
    const attacker = (await globalThis.crypto.subtle.generateKey({ name: 'X25519' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair
    cloud.servedPublicKey = toBase64(
      await globalThis.crypto.subtle.exportKey('raw', attacker.publicKey)
    )
    const r = await run(['team', 'unlock'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(
      /public key Cloud returned for this account does not belong to its private key/
    )
    expect(grants()).toBe(0)
    expect(cloud.wraps).toHaveLength(0)
    expect(existsSync(teamUnlockPath(home))).toBe(false)
  })

  it('a key that reads back different from the one minted is refused, and nothing is unlocked', async () => {
    await cloud.withKeypair()
    // After the grant, the server serves a wrap of a DIFFERENT key - one it
    // knows - wrapped properly to this account.
    const priv = cloud.keypair!.privateKey as unknown as CryptoKeyLike
    const pub = cloud.keypair!.publicKey
    cloud.servedWrap = await wrapTeamKeyFor(new Uint8Array(32).fill(1), priv, pub, pub, {
      teamId: TEAM_ID,
      version: 1,
    })
    const r = await run(['team', 'unlock'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/read back/)
    expect(existsSync(teamUnlockPath(home))).toBe(false)
  })
})

describe('the race: the team got a key first', () => {
  it('the server refuses the bootstrap, this stands down, and no second key exists', async () => {
    await cloud.withKeypair()
    // Somebody else minted v1 a moment ago; none of it is ours.
    cloud.wraps.push({ user: 'u-ada', version: 1, wrapped_key: 'x', wrapped_by: 'u-ada' })
    cloud.usedVersions = 1
    cloud.members = [ME, 'ada@example.test']
    // Our own GET of wraps still says none: we were never granted.
    const r = await run(['team', 'unlock'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(cloud.wraps).toHaveLength(1)
    expect(r.err).toMatch(/granted this account the team key/)
    expect(r.err).toMatch(/team member who holds it/i)
    expect(existsSync(teamUnlockPath(home))).toBe(false)
  })

  it('a member who may not start the key is told who can', async () => {
    await cloud.withKeypair()
    cloud.role = 'member'
    cloud.members = [ME, 'owner@example.test']
    const r = await run(['team', 'unlock'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/Only the team owner or an admin can set up the team key/)
    expect(cloud.wraps).toHaveLength(0)
  })
})

describe('a team of one', () => {
  it('whose key cannot be set up from here is told so without any mention of teammates', async () => {
    await cloud.withKeypair()
    // A key exists that this account does not hold - left by nobody it could ask.
    cloud.wraps.push({ user: 'u-gone', version: 1, wrapped_key: 'x', wrapped_by: 'u-gone' })
    cloud.usedVersions = 1
    const r = await run(['team', 'unlock'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).not.toMatch(/teammate|team member|someone/i)
    expect(r.err).toContain('web app')
  })
})

describe('an account whose keys are not set up', () => {
  it('is told to open the web app once, and nothing is minted', async () => {
    const r = await run(['team', 'unlock'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/keys are not set up yet/)
    expect(r.err).toMatch(/web app/)
    expect(grants()).toBe(0)
  })
})
