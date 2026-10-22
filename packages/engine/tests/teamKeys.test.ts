import { describe, it, expect } from 'vitest'
import {
  importPublicKey,
  unwrapPrivateKey,
  deriveWrappingKey,
  unwrapTeamKey,
  encryptTeamMap,
  importTeamKey,
  decryptTeamMap,
  decryptTeamMapWithAny,
  TeamKeyError,
  USER_KEY_ALG,
  type TeamMapEnvelope,
  type WrapContext,
} from '../src/teamKeys.js'
import { fromBase64, toBase64 } from '../src/envelope.js'
import type { CryptoKeyLike } from '../src/vault.js'

// The read half of the team-key scheme: vault key -> private key -> team key
// -> map.
//
// Granting is still browser-only, so these tests build their own key fixtures
// the way the browser writes them. That is the point of exposure: if the
// browser's write path and this read path ever disagree about a format, a team
// silently loses its shared namespace and nothing here would fail. The fixture
// helpers below therefore mirror `veilio-cloud`'s `createKeypair`,
// `wrapTeamKeyFor` and `encryptTeamMap` exactly, and any change to either side
// should be made in both.
//
// `browserSeal` stays hand-written now that the engine seals too: it is the
// second implementation `encryptTeamMap` is checked against, and collapsing the
// two into one call would delete the only thing that can catch format drift.

const subtle = globalThis.crypto.subtle
const WRAP_ALG = 'AES-GCM'
const enc = new TextEncoder()

/** WebCrypto wants a buffer-backed view; a plain `Uint8Array` is `ArrayBufferLike`
 *  and the two disagree under current lib typings. The bytes are identical, only
 *  the declaration differs. `BufferSource` is not nameable in the engine, whose
 *  tsconfig carries no DOM lib on purpose, so the generic form is used instead. */
const buf = (u: Uint8Array) => u as unknown as Uint8Array<ArrayBuffer>

type Keypair = { publicKey: CryptoKey; privateKey: CryptoKey }

async function makeVaultKey(): Promise<CryptoKey> {
  return subtle.generateKey({ name: WRAP_ALG, length: 256 }, false, ['encrypt', 'decrypt'])
}

async function makeKeypair(): Promise<Keypair> {
  return (await subtle.generateKey({ name: USER_KEY_ALG }, true, [
    'deriveBits',
  ])) as unknown as Keypair
}

/** Mirrors the browser's `createKeypair`: private half wrapped under the vault key. */
async function storePrivateKey(vaultKey: CryptoKey, kp: Keypair): Promise<string> {
  const pkcs8 = await subtle.exportKey('pkcs8', kp.privateKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await subtle.encrypt({ name: WRAP_ALG, iv }, vaultKey, pkcs8)
  return JSON.stringify({ v: 1, alg: WRAP_ALG, iv: toBase64(iv), data: toBase64(data) })
}

async function publicKeyB64(kp: Keypair): Promise<string> {
  return toBase64(await subtle.exportKey('raw', kp.publicKey))
}

/** Mirrors the browser's `wrapTeamKeyFor`. */
async function wrapTeamKeyFor(
  teamKeyRaw: Uint8Array,
  granter: Keypair,
  recipientPublicB64: string,
  ctx: Omit<WrapContext, 'granterPublicKey' | 'recipientPublicKey'>
): Promise<string> {
  const granterPublicKey = await publicKeyB64(granter)
  const recipient = await importPublicKey(recipientPublicB64)
  const wrappingKey = await deriveWrappingKey(
    granter.privateKey as unknown as CryptoKeyLike,
    recipient,
    { ...ctx, granterPublicKey, recipientPublicKey: recipientPublicB64 }
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await subtle.encrypt(
    { name: WRAP_ALG, iv },
    wrappingKey as unknown as CryptoKey,
    buf(teamKeyRaw)
  )
  return JSON.stringify({ v: 1, iv: toBase64(iv), data: toBase64(data), from: granterPublicKey })
}

/** Mirrors the browser's `encryptTeamMap`, byte for byte. Kept hand-written on
 *  purpose: it is the independent implementation the engine's own seal is checked
 *  against, so format drift between the two fails here. */
async function browserSeal(
  teamKeyRaw: Uint8Array,
  map: Record<string, string>
): Promise<TeamMapEnvelope> {
  const key = await subtle.importKey('raw', buf(teamKeyRaw), { name: WRAP_ALG }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await subtle.encrypt({ name: WRAP_ALG, iv }, key, enc.encode(JSON.stringify(map)))
  return { v: 1, alg: 'AES-256-GCM-TEAM', iv: toBase64(iv), data: toBase64(data) }
}

const randomTeamKey = () => crypto.getRandomValues(new Uint8Array(32))

describe('the whole read path', () => {
  it('opens a map written by a teammate', async () => {
    // Alice mints the team key and grants it to Bob; Bob opens a map she wrote.
    const alice = await makeKeypair()
    const bob = await makeKeypair()
    const bobVault = await makeVaultKey()
    const bobStoredPrivate = await storePrivateKey(bobVault, bob)
    const teamKeyRaw = randomTeamKey()
    const bobPublic = await publicKeyB64(bob)

    const wrap = await wrapTeamKeyFor(teamKeyRaw, alice, bobPublic, { teamId: 't1', version: 1 })
    const envelope = await browserSeal(teamKeyRaw, { __CLS__1: 'Invoice' })

    const bobPrivate = await unwrapPrivateKey(
      bobVault as unknown as CryptoKeyLike,
      bobStoredPrivate
    )
    const teamKey = await unwrapTeamKey(wrap, bobPrivate, {
      teamId: 't1',
      version: 1,
      myPublicKey: bobPublic,
    })

    await expect(decryptTeamMap(teamKey, envelope)).resolves.toEqual({ __CLS__1: 'Invoice' })
  })
})

describe('unwrapPrivateKey', () => {
  it('refuses the wrong vault key rather than returning a key made of noise', async () => {
    const kp = await makeKeypair()
    const stored = await storePrivateKey(await makeVaultKey(), kp)
    const wrongVault = (await makeVaultKey()) as unknown as CryptoKeyLike

    // AES-GCM authenticates, so this has to fail here and not much later.
    await expect(unwrapPrivateKey(wrongVault, stored)).rejects.toThrow(TeamKeyError)
  })

  it('rejects a damaged envelope', async () => {
    const vault = (await makeVaultKey()) as unknown as CryptoKeyLike
    await expect(unwrapPrivateKey(vault, 'not json')).rejects.toThrow(/not a valid envelope/)
    await expect(
      unwrapPrivateKey(vault, JSON.stringify({ v: 2, alg: 'AES-GCM', iv: '', data: '' }))
    ).rejects.toThrow(/Unsupported private-key envelope/)
  })
})

describe('importPublicKey', () => {
  it('refuses anything that is not 32 bytes', async () => {
    // Rather than derive a shared secret from whatever it was handed.
    await expect(importPublicKey(toBase64(new Uint8Array(16)))).rejects.toThrow(/must be 32 bytes/)
  })

  it('refuses input that is not base64', async () => {
    await expect(importPublicKey('!!!!')).rejects.toThrow(TeamKeyError)
  })
})

describe('the wrap context', () => {
  // The binding that stops a wrap being moved somewhere it was not addressed.
  // Each case below is a real leak the context was added to close.
  const base = { teamId: 't1', version: 1 }

  it('refuses a wrap re-filed under a different team', async () => {
    const alice = await makeKeypair()
    const bob = await makeKeypair()
    const bobPublic = await publicKeyB64(bob)
    const wrap = await wrapTeamKeyFor(randomTeamKey(), alice, bobPublic, base)

    await expect(
      unwrapTeamKey(wrap, bob.privateKey as unknown as CryptoKeyLike, {
        teamId: 'OTHER-TEAM',
        version: 1,
        myPublicKey: bobPublic,
      })
    ).rejects.toThrow(/could not be opened/)
  })

  it('refuses a v1 wrap presented as v2, so removal still rotates', async () => {
    const alice = await makeKeypair()
    const bob = await makeKeypair()
    const bobPublic = await publicKeyB64(bob)
    const wrap = await wrapTeamKeyFor(randomTeamKey(), alice, bobPublic, base)

    await expect(
      unwrapTeamKey(wrap, bob.privateKey as unknown as CryptoKeyLike, {
        teamId: 't1',
        version: 2,
        myPublicKey: bobPublic,
      })
    ).rejects.toThrow(/could not be opened/)
  })

  it("refuses a wrap addressed to somebody else's key", async () => {
    const alice = await makeKeypair()
    const bob = await makeKeypair()
    const mallory = await makeKeypair()
    const wrap = await wrapTeamKeyFor(randomTeamKey(), alice, await publicKeyB64(bob), base)

    await expect(
      unwrapTeamKey(wrap, mallory.privateKey as unknown as CryptoKeyLike, {
        teamId: 't1',
        version: 1,
        myPublicKey: await publicKeyB64(mallory),
      })
    ).rejects.toThrow(/could not be opened/)
  })

  it('rejects a malformed wrap', async () => {
    const bob = await makeKeypair()
    const priv = bob.privateKey as unknown as CryptoKeyLike
    const ctx = { teamId: 't1', version: 1, myPublicKey: await publicKeyB64(bob) }
    await expect(unwrapTeamKey('not json', priv, ctx)).rejects.toThrow(/not valid JSON/)
    await expect(unwrapTeamKey(JSON.stringify({ v: 1 }), priv, ctx)).rejects.toThrow(/Unsupported/)
  })
})

describe('decryptTeamMap', () => {
  it('refuses an envelope tagged as something else', async () => {
    // The vault envelope is a sibling format under a different tag. Confusing
    // the two silently would misreport what a passphrase loss costs.
    const teamKeyRaw = randomTeamKey()
    const env = await browserSeal(teamKeyRaw, { __CLS__1: 'Invoice' })
    const key = await subtle.importKey('raw', buf(teamKeyRaw), { name: WRAP_ALG }, false, [
      'decrypt',
    ])

    await expect(
      decryptTeamMap(key as unknown as CryptoKeyLike, {
        ...env,
        alg: 'AES-256-GCM-PBKDF2' as TeamMapEnvelope['alg'],
      })
    ).rejects.toThrow(/Unsupported team map envelope/)
  })

  it('refuses altered ciphertext rather than returning nonsense identifiers', async () => {
    const teamKeyRaw = randomTeamKey()
    const env = await browserSeal(teamKeyRaw, { __CLS__1: 'Invoice' })
    const key = await subtle.importKey('raw', buf(teamKeyRaw), { name: WRAP_ALG }, false, [
      'decrypt',
    ])
    const tampered = { ...env, data: toBase64(new Uint8Array(40)) }

    await expect(decryptTeamMap(key as unknown as CryptoKeyLike, tampered)).rejects.toThrow(
      /could not be opened/
    )
  })
})

describe('decryptTeamMapWithAny', () => {
  async function keyOf(raw: Uint8Array): Promise<CryptoKeyLike> {
    return (await subtle.importKey('raw', buf(raw), { name: WRAP_ALG }, false, [
      'decrypt',
    ])) as unknown as CryptoKeyLike
  }

  it('opens a map mid-rotation, whichever version wrote it', async () => {
    // A team holds two versions at once during a rotation, and the envelope
    // carries a schema version rather than a key version - so the only way to
    // know is to try.
    const v1Raw = randomTeamKey()
    const v2Raw = randomTeamKey()
    const held = [
      { version: 1, key: await keyOf(v1Raw) },
      { version: 2, key: await keyOf(v2Raw) },
    ]

    const writtenUnderV1 = await browserSeal(v1Raw, { __CLS__1: 'Old' })
    const writtenUnderV2 = await browserSeal(v2Raw, { __CLS__2: 'New' })

    await expect(decryptTeamMapWithAny(held, writtenUnderV1)).resolves.toEqual({ __CLS__1: 'Old' })
    await expect(decryptTeamMapWithAny(held, writtenUnderV2)).resolves.toEqual({ __CLS__2: 'New' })
  })

  it('reports every version tried when none fit', async () => {
    const held = [
      { version: 1, key: await keyOf(randomTeamKey()) },
      { version: 2, key: await keyOf(randomTeamKey()) },
    ]
    const foreign = await browserSeal(randomTeamKey(), { __CLS__1: 'Invoice' })

    await expect(decryptTeamMapWithAny(held, foreign)).rejects.toThrow(/tried v2, v1/)
  })

  it('says so plainly when no key is held at all', async () => {
    const env = await browserSeal(randomTeamKey(), {})
    await expect(decryptTeamMapWithAny([], env)).rejects.toThrow(/No team key is held/)
  })
})

// ─── encryptTeamMap: the write half ─────────────────────────────────────────
//
// The seal `veilio maps push --team` needs (spec 011). Sealing is NOT granting:
// it widens nothing about who can read the team's maps, which is why it may run
// outside a browser where `wrapTeamKeyFor` may not.
//
// Matrix below: positive round-trips, the IV property AES-GCM lives or dies on,
// the envelope stamp, negative paths (wrong key, wrong usage, every shape of
// tampering), payload edge cases that a real codebase actually produces, the
// server's size ceiling, and agreement with the browser.

describe('encryptTeamMap', () => {
  const keyFor = (raw: Uint8Array) => importTeamKey(toBase64(raw))

  // ── positive ──────────────────────────────────────────────────────────────

  it('round-trips through decryptTeamMap', async () => {
    const key = await keyFor(randomTeamKey())
    const map = { __CLS__1: 'Invoice', __FN__1: 'chargeCard', __VAR__7: 'apiToken' }

    await expect(decryptTeamMap(key, await encryptTeamMap(key, map))).resolves.toEqual(map)
  })

  it('round-trips identifiers carrying quotes, newlines and non-ASCII', async () => {
    // An identifier is a real name out of someone's codebase, not a sanitised
    // token. The payload is JSON inside the ciphertext, so whatever survives
    // JSON survives this — pinned so nobody adds an escaping layer that does
    // not round-trip.
    const key = await keyFor(randomTeamKey())
    const map = {
      __CLS__1: 'O\'Brien"Factory',
      __FN__1: 'obliczFakturę',
      __VAR__1: 'line\nbreak\ttab',
      __CLS__2: '発注書',
      __FN__2: 'émoji🔐Handler',
    }

    await expect(decryptTeamMap(key, await encryptTeamMap(key, map))).resolves.toEqual(map)
  })

  it('round-trips a thousand entries', async () => {
    const key = await keyFor(randomTeamKey())
    const map = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`__FN__${i + 1}`, `handler${i + 1}`])
    )

    await expect(decryptTeamMap(key, await encryptTeamMap(key, map))).resolves.toEqual(map)
  })

  it('seals the same map unrecognisably under two different keys', async () => {
    // Two teams holding the same identifiers must not produce comparable
    // ciphertext — otherwise the server, which holds both rows, could tell that
    // team A and team B named the same thing without opening either.
    const map = { __CLS__1: 'Invoice' }
    const a = await encryptTeamMap(await keyFor(randomTeamKey()), map)
    const b = await encryptTeamMap(await keyFor(randomTeamKey()), map)

    expect(a.data).not.toBe(b.data)
  })

  it('carries exactly v, alg, iv and data — nothing about the map', async () => {
    // Any extra field is a side channel. An identifier count, a name, a key
    // version: each would tell the server something it is not supposed to know,
    // and the row's own columns already carry what it legitimately needs.
    const key = await keyFor(randomTeamKey())
    const env = await encryptTeamMap(key, { __CLS__1: 'Invoice', __FN__2: 'chargeCard' })

    expect(Object.keys(env).sort()).toEqual(['alg', 'data', 'iv', 'v'])
  })

  // ── the iv ────────────────────────────────────────────────────────────────

  it('never reuses an iv for the same map under the same key', async () => {
    // AES-GCM loses confidentiality AND authenticity when an IV repeats under
    // one key, and two members sealing identical pairs is ordinary rather than
    // unlikely. An IV derived from the map would collide exactly there.
    const key = await keyFor(randomTeamKey())
    const map = { __CLS__1: 'Invoice' }

    const first = await encryptTeamMap(key, map)
    const second = await encryptTeamMap(key, map)

    expect(first.iv).not.toBe(second.iv)
    expect(first.data).not.toBe(second.data)
  })

  it('draws a fresh 12-byte iv, the width AES-GCM is specified for', async () => {
    const key = await keyFor(randomTeamKey())
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const env = await encryptTeamMap(key, { __CLS__1: 'Invoice' })
      expect(fromBase64(env.iv).byteLength).toBe(12)
      seen.add(env.iv)
    }
    expect(seen.size).toBe(20)
  })

  // ── the stamp ─────────────────────────────────────────────────────────────

  it('stamps the team tag, not the vault tag', async () => {
    // The sibling vault format is AES-256-GCM-PBKDF2. Stamping that here would
    // tell a future reader that one person's passphrase loss takes the team's
    // map with it, which is the opposite of how a team key behaves.
    const key = await keyFor(randomTeamKey())
    const env = await encryptTeamMap(key, { __CLS__1: 'Invoice' })

    expect(env.v).toBe(1)
    expect(env.alg).toBe('AES-256-GCM-TEAM')
  })

  // ── negative: the key ─────────────────────────────────────────────────────

  it('refuses a key that was never given encrypt usage', async () => {
    // `importTeamKey` grants both, so this cannot arise through the engine's
    // own door. It can arise through a caller that built its own key, and the
    // failure must be a throw rather than an envelope nobody can open.
    const readOnly = await subtle.importKey(
      'raw',
      buf(randomTeamKey()),
      { name: WRAP_ALG },
      false,
      ['decrypt']
    )

    await expect(
      encryptTeamMap(readOnly as unknown as CryptoKeyLike, { __CLS__1: 'Invoice' })
    ).rejects.toThrow()
  })

  it('rejects a non-key instead of producing something unopenable', async () => {
    await expect(
      encryptTeamMap(null as unknown as CryptoKeyLike, { __CLS__1: 'Invoice' })
    ).rejects.toThrow()
  })

  it('produces an envelope no other team key opens', async () => {
    const mine = await keyFor(randomTeamKey())
    const theirs = await keyFor(randomTeamKey())
    const env = await encryptTeamMap(mine, { __CLS__1: 'Invoice' })

    await expect(decryptTeamMap(theirs, env)).rejects.toThrow(/could not be opened/)
  })

  // ── negative: tampering ───────────────────────────────────────────────────

  it('produces an envelope that refuses to open once the ciphertext is altered', async () => {
    const key = await keyFor(randomTeamKey())
    const env = await encryptTeamMap(key, { __CLS__1: 'Invoice' })
    const flipped = fromBase64(env.data)
    flipped[0] ^= 0xff

    await expect(decryptTeamMap(key, { ...env, data: toBase64(flipped) })).rejects.toThrow(
      /could not be opened/
    )
  })

  it('refuses an envelope whose iv was replaced with another', async () => {
    // The IV is authenticated along with the ciphertext, so swapping it is
    // caught rather than silently decrypting to different bytes.
    const key = await keyFor(randomTeamKey())
    const env = await encryptTeamMap(key, { __CLS__1: 'Invoice' })
    const other = await encryptTeamMap(key, { __CLS__1: 'Invoice' })

    await expect(decryptTeamMap(key, { ...env, iv: other.iv })).rejects.toThrow(
      /could not be opened/
    )
  })

  it('refuses ciphertext borrowed from another envelope under the same key', async () => {
    // Two maps in one team are sealed under one key. Splicing row A's data onto
    // row B's IV must fail, or a member could swap two maps' contents without
    // holding the key at all.
    const key = await keyFor(randomTeamKey())
    const a = await encryptTeamMap(key, { __CLS__1: 'Invoice' })
    const b = await encryptTeamMap(key, { __CLS__2: 'Shipment' })

    await expect(decryptTeamMap(key, { ...a, data: b.data })).rejects.toThrow(/could not be opened/)
  })

  it('refuses a truncated ciphertext rather than returning a partial map', async () => {
    const key = await keyFor(randomTeamKey())
    const env = await encryptTeamMap(key, { __CLS__1: 'Invoice', __FN__2: 'chargeCard' })
    const cut = fromBase64(env.data).slice(0, 8)

    await expect(decryptTeamMap(key, { ...env, data: toBase64(cut) })).rejects.toThrow(
      /could not be opened/
    )
  })

  it('refuses a schema version from the future', async () => {
    // Forward compatibility is declined on purpose: a v2 envelope this build
    // cannot read must say so, not get trial-decrypted as v1.
    const key = await keyFor(randomTeamKey())
    const env = await encryptTeamMap(key, { __CLS__1: 'Invoice' })

    await expect(decryptTeamMap(key, { ...env, v: 2 as TeamMapEnvelope['v'] })).rejects.toThrow(
      /Unsupported team map envelope/
    )
  })

  // ── edge: payload shapes a real codebase produces ─────────────────────────

  it('round-trips an empty map rather than refusing it', async () => {
    // Refusing to publish nothing is the CLI's call (FR-004), made before this
    // is reached. Deciding it here as well would put the message in the layer
    // that cannot word it, and would make a legitimately emptied map
    // unrewritable during a key rotation.
    const key = await keyFor(randomTeamKey())

    await expect(decryptTeamMap(key, await encryptTeamMap(key, {}))).resolves.toEqual({})
  })

  it('round-trips dangerous object keys without touching a prototype', async () => {
    // `__proto__` is a plausible masked name in JavaScript code. JSON.parse
    // creates it as an own property rather than assigning the prototype, and
    // this pins that: a regression here is prototype pollution driven by a
    // teammate's identifier.
    const key = await keyFor(randomTeamKey())
    const map = { ['__proto__']: 'Polluted', constructor: 'Ctor', toString: 'Str' }

    const back = await decryptTeamMap(key, await encryptTeamMap(key, map))

    expect(Object.getPrototypeOf(back)).toBe(Object.prototype)
    expect(Object.hasOwn(back, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(back, '__proto__')?.value).toBe('Polluted')
    expect(back['constructor']).toBe('Ctor')
    expect({}).not.toHaveProperty('Polluted')
  })

  it('round-trips a NUL byte, which the floor marker is built from', async () => {
    // `anonymizeAbove` marks floors with a NUL-prefixed identifier and strips
    // them before anything is sealed. If one ever reached here it must survive
    // byte-exact, so the bug is visible rather than silently rewritten.
    const key = await keyFor(randomTeamKey())
    const map = { __CLS__1: '\u0000CLS', __FN__1: 'mid\u0000dle' }

    await expect(decryptTeamMap(key, await encryptTeamMap(key, map))).resolves.toEqual(map)
  })

  it('round-trips a lone surrogate', async () => {
    // An unpaired surrogate is not valid UTF-16 text and TextEncoder would
    // replace it; JSON.stringify escapes it first (well-formed stringify), so
    // it survives. Pinned because the order of those two steps is load-bearing.
    const key = await keyFor(randomTeamKey())
    const map = { __CLS__1: 'lone\ud800surrogate' }

    await expect(decryptTeamMap(key, await encryptTeamMap(key, map))).resolves.toEqual(map)
  })

  it('round-trips an identifier far longer than any real one', async () => {
    const key = await keyFor(randomTeamKey())
    const map = { __CLS__1: 'A'.repeat(10_000) }

    await expect(decryptTeamMap(key, await encryptTeamMap(key, map))).resolves.toEqual(map)
  })

  it('does not police placeholder shape — that belongs to the caller', async () => {
    // Deliberate. The engine seals what it is handed; `__[A-Z][A-Z0-9_]*__` is
    // enforced where placeholders are MINTED and where the reservation request
    // is built. Validating here too would reject a map mid-rotation that was
    // legitimately written by an older client.
    const key = await keyFor(randomTeamKey())
    const map = { 'not-a-placeholder': 'Invoice', '': 'empty' }

    await expect(decryptTeamMap(key, await encryptTeamMap(key, map))).resolves.toEqual(map)
  })

  // ── edge: the server's envelope ceiling ───────────────────────────────────

  it('leaves a realistic team map well inside the 256,000-byte ceiling', async () => {
    // Cloud refuses `map_data` over MAX_ENVELOPE_BYTES = 256_000, measured on
    // the JSON string. The CLI must know this BEFORE uploading (T020), so the
    // headroom is pinned here rather than discovered as a 413 on staging.
    const key = await keyFor(randomTeamKey())
    const map = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`__FN__${i + 1}`, `paymentHandler${i + 1}`])
    )

    const wire = JSON.stringify(await encryptTeamMap(key, map))
    expect(wire.length).toBeLessThan(100_000)
  })

  it('crosses the ceiling only well past any plausible map', async () => {
    // The other side of the same bound: base64 costs 4/3, so the envelope
    // outgrows 256,000 bytes somewhere past ~6,000 identifiers. A team that
    // large has a different problem, but the refusal must exist.
    const key = await keyFor(randomTeamKey())
    const map = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, i) => [`__FN__${i + 1}`, `paymentHandler${i + 1}`])
    )

    const wire = JSON.stringify(await encryptTeamMap(key, map))
    expect(wire.length).toBeGreaterThan(256_000)
  })

  // ── cross-implementation: the drift guard (T005) ──────────────────────────

  it('opens an envelope frozen from the browser’s own implementation', async () => {
    // Captured by running `veilio-cloud`'s `encryptTeamMap` under tsx against
    // the fixed test key below, then pasted here verbatim. Frozen BYTES, not a
    // re-derivation: `browserSeal` lives in this file and would move with any
    // edit to it, so only a constant can catch the web app and the engine
    // drifting apart. If this ever fails, one side changed the wire format and
    // every existing team map became unreadable by the other.
    //
    // The key is bytes 1..32 — a test vector, not a secret.
    const FROZEN_KEY_B64 = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA='
    const FROZEN_ENVELOPE: TeamMapEnvelope = {
      v: 1,
      alg: 'AES-256-GCM-TEAM',
      iv: 'HEtRwXMTKiBUw5OU',
      data:
        'M7hgMsYaZZZ3piYPmhNnfi+g0ab9IXqYE4D3UJT/iRAmtiiyasSIRbgbEn/AVhxWReMFlRRbk5ZQSD/C' +
        '3CULoe9bE9CidVQ7NA710JxjSegP0qdWYZnrhJegdfU0W+m9Uz0d5u1rm0jVoi0zJ7yf6qA=',
    }
    const key = await importTeamKey(FROZEN_KEY_B64)

    await expect(decryptTeamMap(key, FROZEN_ENVELOPE)).resolves.toEqual({
      __CLS__1: 'PaymentProcessor',
      __FN__2: 'chargeCard',
      __VAR__3: 'apiToken',
      __CLS__4: 'Faktura',
    })
  })

  it('seals what the browser can open, in the same shape', async () => {
    const raw = randomTeamKey()
    const key = await keyFor(raw)
    const map = { __CLS__1: 'Invoice', __FN__3: 'chargeCard' }

    const fromEngine = await encryptTeamMap(key, map)
    const fromBrowser = await browserSeal(raw, map)

    // Each opens through the engine's read path...
    await expect(decryptTeamMap(key, fromEngine)).resolves.toEqual(map)
    await expect(decryptTeamMap(key, fromBrowser)).resolves.toEqual(map)
    // ...and through the trial-decryption path a member uses mid-rotation.
    const held = [{ version: 1, key }]
    await expect(decryptTeamMapWithAny(held, fromEngine)).resolves.toEqual(map)
    await expect(decryptTeamMapWithAny(held, fromBrowser)).resolves.toEqual(map)

    // Same shape, so nobody can tell which surface wrote a given map.
    expect(Object.keys(fromEngine).sort()).toEqual(Object.keys(fromBrowser).sort())
    expect(fromEngine.v).toBe(fromBrowser.v)
    expect(fromEngine.alg).toBe(fromBrowser.alg)
    expect(fromBase64(fromEngine.iv).byteLength).toBe(fromBase64(fromBrowser.iv).byteLength)
    // AES-GCM appends a 16-byte tag; equal plaintext means equal length.
    expect(fromBase64(fromEngine.data).byteLength).toBe(fromBase64(fromBrowser.data).byteLength)
  })

  it('opens under decryptTeamMapWithAny mid-rotation, like any other envelope', async () => {
    const held = [
      { version: 1, key: await keyFor(randomTeamKey()) },
      { version: 2, key: await keyFor(randomTeamKey()) },
    ]

    const sealedUnderV1 = await encryptTeamMap(held[0]!.key, { __CLS__1: 'Old' })
    const sealedUnderV2 = await encryptTeamMap(held[1]!.key, { __CLS__2: 'New' })

    await expect(decryptTeamMapWithAny(held, sealedUnderV1)).resolves.toEqual({ __CLS__1: 'Old' })
    await expect(decryptTeamMapWithAny(held, sealedUnderV2)).resolves.toEqual({ __CLS__2: 'New' })
  })
})
