import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  decryptMapFromVault,
  fromBase64,
  parseVaultEnvelope,
  toBase64,
  type SymbolMap,
} from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { feedSecret } from '../src/secret-input.js'
import {
  importPersonalMapsKey,
  personalMapsKeyPath,
  unwrapPersonalMapsKey,
  wrapPersonalMapsKey,
} from '../src/client/personal-maps-key.js'
import {
  FakeCloud,
  INSTANCE,
  ME,
  PASSPHRASE,
  PMK_RAW,
  TEAMMATE,
  sealPersonal,
  sealTeam,
  signIn,
  vaultKey,
} from './helpers/fake-cloud.js'

/**
 * `veilio vault unlock` / `vault lock` (spec 052 FR-011, T014).
 *
 * The promise being tested is narrow and absolute: the terminal keeps the
 * PERSONAL-MAPS key and nothing else. Not the passphrase, not the vault key,
 * not the wrapped blob. "Nothing else" is checked by reading every file the
 * run left under the temporary home and every byte it sent - and, because the
 * vault key is non-extractable and so cannot be searched for as bytes, by
 * proving what the stored key IS: it opens a map sealed under the
 * personal-maps key, and does not open one sealed under the vault key.
 */

let home: string
let cloud: FakeCloud

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'veilio-vault-home-'))
  cloud = new FakeCloud()
  await cloud.withVault()
  vi.stubGlobal('fetch', cloud.fetch)
  signIn(home)
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
})

async function run(
  argv: string[],
  passphrase: string = PASSPHRASE
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd: home,
    home,
    stdin: async () => '',
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => passphrase,
  }
  return { code: await main(argv, io), out, err }
}

/** Every file under the temp home, with its contents. */
function filesUnderHome(): { path: string; text: string }[] {
  return readdirSync(home, { recursive: true, encoding: 'utf8' })
    .map((n) => join(home, n))
    .filter((p) => statSync(p).isFile())
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
}

function storedKey(): Uint8Array {
  const parsed = JSON.parse(readFileSync(personalMapsKeyPath(home), 'utf8')) as { key: string }
  return fromBase64(parsed.key)
}

async function opensWith(raw: Uint8Array, mapData: string): Promise<SymbolMap | null> {
  try {
    return await decryptMapFromVault(await importPersonalMapsKey(raw), parseVaultEnvelope(mapData))
  } catch {
    return null
  }
}

describe('the wrap: AES-GCM under the vault key, bound to its purpose', () => {
  const AAD = new TextEncoder().encode('veilio-pmk-wrap-v1')

  it('matches WebCrypto called directly: {v:1, alg:"AES-GCM", iv, data}, AAD "veilio-pmk-wrap-v1"', async () => {
    const iv = new Uint8Array(12).fill(4)
    const key = await vaultKey()
    const ours = await wrapPersonalMapsKey(key, PMK_RAW, iv)
    // Built here without this package's code.
    const ct = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: AAD },
      key as unknown as CryptoKey,
      PMK_RAW
    )
    expect(ours).toBe(
      JSON.stringify({ v: 1, alg: 'AES-GCM', iv: toBase64(iv), data: toBase64(ct) })
    )
    expect(Object.keys(JSON.parse(ours) as object)).toEqual(['v', 'alg', 'iv', 'data'])
    expect(await unwrapPersonalMapsKey(key, ours)).toEqual(PMK_RAW)
  })

  it('the shared vector: the web app’s suite asserts the same bytes', async () => {
    const vault = await globalThis.crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(1),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    )
    const wrapped = await wrapPersonalMapsKey(
      vault,
      new Uint8Array(32).fill(2),
      new Uint8Array(12).fill(3)
    )
    expect(wrapped).toBe(
      '{"v":1,"alg":"AES-GCM","iv":"AwMDAwMDAwMDAwMD","data":"+mMWmP2GNWuv/uRlzhsmqroxo0+FzcCwrhK/RKhIhHEiQDcVhjFtXLjZQTREBYtr"}'
    )
    expect(await unwrapPersonalMapsKey(vault, wrapped)).toEqual(new Uint8Array(32).fill(2))
  })

  it('a wrap made without the AAD does not unwrap - another blob under the vault key cannot pass for it', async () => {
    const iv = new Uint8Array(12).fill(4)
    const key = await vaultKey()
    const ct = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key as unknown as CryptoKey,
      PMK_RAW
    )
    const bare = JSON.stringify({ v: 1, alg: 'AES-GCM', iv: toBase64(iv), data: toBase64(ct) })
    await expect(unwrapPersonalMapsKey(key, bare)).rejects.toThrow()
  })

  it('a wrong vault key fails cleanly rather than yielding a key', async () => {
    const wrapped = await wrapPersonalMapsKey(await vaultKey(), PMK_RAW)
    const other = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
    await expect(unwrapPersonalMapsKey(other, wrapped)).rejects.toThrow()
  })
})

describe('the first unlock', () => {
  it('creates a personal-maps key, uploads it wrapped, and keeps only the key here', async () => {
    const r = await run(['vault', 'unlock'])
    expect(r.code, r.err).toBe(EXIT_OK)

    const puts = cloud.requests.filter((x) => x.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(cloud.pmkWrap).not.toBeNull()
    // What went up opens, under the vault key, to what was kept here.
    expect(await unwrapPersonalMapsKey(await vaultKey(), cloud.pmkWrap!)).toEqual(storedKey())

    const path = personalMapsKeyPath(home)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(Object.keys(stored).sort()).toEqual(['account', 'expiresAt', 'instance', 'key', 'v'])
    expect(stored.instance).toBe(INSTANCE)
    expect(stored.account).toBe(ME)
    const days = (Date.parse(String(stored.expiresAt)) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)
    expect(r.out).toContain(path)
    expect(r.out).toContain('`veilio vault lock`')
  })

  it('the stored key opens a map sealed under it, and NOT one sealed under the vault key', async () => {
    await run(['vault', 'unlock'])
    const raw = storedKey()
    const underPmk = JSON.stringify(
      await (
        await import('@veilio-inc/engine')
      ).encryptMapForVault(await importPersonalMapsKey(raw), {
        __CLS__1: 'A',
      })
    )
    expect(await opensWith(raw, underPmk)).toEqual({ __CLS__1: 'A' })
    expect(await opensWith(raw, await sealPersonal({ __CLS__1: 'A' }, 'vault'))).toBeNull()
  })

  it('leaves no passphrase, wrapped key or private key in any file, any request, or the output', async () => {
    const r = await run(['vault', 'unlock'])
    const wrapped = cloud.pmkWrap!
    const forbidden = [PASSPHRASE, wrapped, JSON.parse(wrapped).data as string]
    for (const { path, text } of filesUnderHome()) {
      for (const secret of forbidden) expect(text, `${path} holds a secret`).not.toContain(secret)
    }
    expect(
      filesUnderHome()
        .map((f) => f.path.slice(home.length))
        .sort()
    ).toEqual(['/.veilio/credential.json', '/.veilio/personal-maps-key.json'])
    expect(cloud.wire()).not.toContain(PASSPHRASE)
    expect(r.out + r.err).not.toContain(toBase64(storedKey()))
    for (const secret of forbidden) expect(r.out + r.err).not.toContain(secret)
  })

  it('--days sets how long it lasts', async () => {
    const r = await run(['vault', 'unlock', '--days', '2'])
    expect(r.code, r.err).toBe(EXIT_OK)
    const stored = JSON.parse(readFileSync(personalMapsKeyPath(home), 'utf8')) as {
      expiresAt: string
    }
    const days = (Date.parse(stored.expiresAt) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(1.9)
    expect(days).toBeLessThan(2.1)
  })

  it('--days must be a whole number of days, 1 to 30', async () => {
    for (const bad of ['0', '31', '1.5', 'x']) {
      const r = await run(['vault', 'unlock', '--days', bad])
      expect(r.code).toBe(EXIT_ERROR)
      expect(r.err).toMatch(/--days/)
    }
    expect(cloud.requests).toHaveLength(0)
  })

  it('a second client creating one at the same moment: its key is used, never replaced', async () => {
    // Our GET says none; by our PUT, another client has stored one (409).
    const theirs = await wrapPersonalMapsKey(await vaultKey(), PMK_RAW)
    const real = cloud.fetch
    let first = true
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (
        new URL(url).pathname === '/api/auth/keys/personal-maps' &&
        (init?.method ?? 'GET') === 'GET' &&
        first
      ) {
        first = false
        cloud.pmkWrap = theirs
        return new Response(JSON.stringify({ wrapped: null }), { status: 200 })
      }
      return real(url, init)
    })
    const r = await run(['vault', 'unlock'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(cloud.pmkWrap).toBe(theirs)
    expect(storedKey()).toEqual(PMK_RAW)
  })
})

describe('an account whose keys are not set up yet', () => {
  it('is refused, naming the web-app step - not treated as another client winning a race', async () => {
    cloud.keysSetUp = false
    const r = await run(['vault', 'unlock'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/web app/)
    expect(r.err).toMatch(/unlock your vault/i)
    expect(r.err).not.toMatch(/damaged/)
    // A race would GET the key again; this must not.
    expect(
      cloud.requests.filter((x) => x.path === '/api/auth/keys/personal-maps' && x.method === 'GET')
    ).toHaveLength(1)
    expect(existsSync(personalMapsKeyPath(home))).toBe(false)
    expect(cloud.pmkWrap).toBeNull()
  })
})

describe('the next unlock', () => {
  it('unwraps the stored key and creates no second one', async () => {
    await cloud.withPmkWrap()
    const before = cloud.pmkWrap
    const r = await run(['vault', 'unlock'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(cloud.requests.filter((x) => x.method === 'PUT')).toHaveLength(0)
    expect(cloud.pmkWrap).toBe(before)
    expect(storedKey()).toEqual(PMK_RAW)
  })
})

describe('older personal maps are re-sealed while the vault key is in hand', () => {
  it('re-seals vault-key maps under the personal-maps key, and leaves the rest alone', async () => {
    await cloud.withPmkWrap()
    const old = cloud.add({
      name: 'old',
      map_data: await sealPersonal({ __CLS__1: 'Old' }, 'vault'),
    })
    const already = cloud.add({
      name: 'new',
      map_data: await sealPersonal({ __CLS__2: 'New' }, 'pmk'),
    })
    const team = cloud.add({
      scope: 'team',
      name: 'shared',
      map_data: await sealTeam({ __CLS__3: 'T' }),
    })
    const theirs = cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      map_data: await sealTeam({ __CLS__4: 'X' }),
    })
    const untouched = [already, team, theirs].map((m) => m.map_data)

    const r = await run(['vault', 'unlock'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(await opensWith(PMK_RAW, cloud.find(old.id)!.map_data)).toEqual({ __CLS__1: 'Old' })
    expect([already, team, theirs].map((m) => cloud.find(m.id)!.map_data)).toEqual(untouched)
    const patches = cloud.requests.filter((x) => x.method === 'PATCH')
    expect(patches.map((p) => p.path)).toEqual([`/api/maps/${old.id}`])
    expect(patches[0]!.body?.if_updated_at).toBeDefined()
    expect(r.out).toMatch(/Re-sealed 1 personal map/)
  })

  it('a map that could not be re-sealed is named, the key is still kept, and the exit says so', async () => {
    await cloud.withPmkWrap()
    const old = cloud.add({
      name: 'old',
      map_data: await sealPersonal({ __CLS__1: 'Old' }, 'vault'),
    })
    cloud.afterGet = (m) => (m.updated_at = '2026-10-25T00:00:00.000Z')
    const r = await run(['vault', 'unlock'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain(`"old" (${old.id})`)
    expect(r.err).toContain('`veilio vault unlock`')
    expect(existsSync(personalMapsKeyPath(home))).toBe(true)
  })
})

describe('refusals leave nothing behind', () => {
  it('a wrong passphrase writes nothing and sends nothing', async () => {
    const r = await run(['vault', 'unlock'], 'not the passphrase at all')
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/not right/)
    expect(existsSync(personalMapsKeyPath(home))).toBe(false)
    expect(cloud.writes()).toHaveLength(0)
  })

  it('no passphrase given', async () => {
    const r = await run(['vault', 'unlock'], '')
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/no passphrase given/)
    expect(existsSync(personalMapsKeyPath(home))).toBe(false)
  })

  it('an account with no vault', async () => {
    cloud.vault = null
    const r = await run(['vault', 'unlock'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/no vault/)
    expect(existsSync(personalMapsKeyPath(home))).toBe(false)
  })

  it('a damaged wrap on the account is refused, and never replaced', async () => {
    cloud.pmkWrap = JSON.stringify({
      v: 1,
      alg: 'AES-GCM',
      iv: toBase64(new Uint8Array(12)),
      data: 'AAAA',
    })
    const r = await run(['vault', 'unlock'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/damaged/)
    expect(cloud.writes()).toHaveLength(0)
    expect(existsSync(personalMapsKeyPath(home))).toBe(false)
  })

  it('signed out: the sign-in sentence, and no request', async () => {
    rmSync(join(home, '.veilio', 'credential.json'))
    const r = await run(['vault', 'unlock'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toBe('veilio: not signed in. Run `veilio login` first.\n')
    expect(cloud.requests).toHaveLength(0)
  })
})

describe('a pasted passphrase', () => {
  it('unlocks with the bracketed-paste markers the terminal wrapped it in', async () => {
    // What readSecret does with a TTY: each raw chunk through feedSecret.
    const typed = feedSecret(
      { value: '', done: false, cancelled: false },
      `\u001b[200~${PASSPHRASE}\u001b[201~\r`
    )
    expect(typed.done).toBe(true)
    const r = await run(['vault', 'unlock'], typed.value)
    expect(r.code, r.err).toBe(EXIT_OK)
  })
})

describe('vault lock', () => {
  it('removes the key, and says so', async () => {
    await run(['vault', 'unlock'])
    const r = await run(['vault', 'lock'])
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toMatch(/locked/i)
    expect(existsSync(personalMapsKeyPath(home))).toBe(false)
  })

  it('with nothing unlocked, says that, exit 0, no request', async () => {
    const r = await run(['vault', 'lock'])
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toMatch(/no personal-maps key was unlocked/i)
    expect(cloud.requests).toHaveLength(0)
  })

  it('logout removes it too: signing out must not leave key material behind', async () => {
    await run(['vault', 'unlock'])
    mkdirSync(join(home, '.veilio'), { recursive: true })
    const r = await run(['logout'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(existsSync(personalMapsKeyPath(home))).toBe(false)
  })
})

describe('after unlocking, personal maps work with no passphrase', () => {
  it('pull opens a map sealed under the key, without asking', async () => {
    await cloud.withPmkWrap()
    await run(['vault', 'unlock'])
    const row = cloud.add({
      name: 'mine',
      map_data: await sealPersonal({ __CLS__1: 'Ledger' }, 'pmk'),
    })
    const cwd = mkdtempSync(join(tmpdir(), 'veilio-vault-work-'))
    mkdirSync(join(cwd, '.git'))
    let asked = 0
    let err = ''
    const code = await main(['maps', 'pull', row.id], {
      cwd,
      home,
      stdin: async () => '',
      stdout: () => undefined,
      stderr: (t) => (err += t),
      password: async () => {
        asked++
        return PASSPHRASE
      },
    })
    expect(code, err).toBe(EXIT_OK)
    expect(asked).toBe(0)
    rmSync(cwd, { recursive: true, force: true })
  })
})
