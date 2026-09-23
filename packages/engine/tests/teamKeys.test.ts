import { describe, it, expect } from 'vitest'
import {
  importPublicKey,
  unwrapPrivateKey,
  deriveWrappingKey,
  unwrapTeamKey,
  decryptTeamMap,
  decryptTeamMapWithAny,
  TeamKeyError,
  USER_KEY_ALG,
  type TeamMapEnvelope,
  type WrapContext,
} from '../src/teamKeys.js'
import { toBase64 } from '../src/envelope.js'
import type { CryptoKeyLike } from '../src/vault.js'

// The read half of the team-key scheme: vault key -> private key -> team key
// -> map.
//
// Only the read half is in the engine, so these tests build their own fixtures
// the way the browser writes them. That is the point of exposure: if the
// browser's write path and this read path ever disagree about a format, a team
// silently loses its shared namespace and nothing here would fail. The fixture
// helpers below therefore mirror `veilio-cloud`'s `createKeypair`,
// `wrapTeamKeyFor` and `encryptTeamMap` exactly, and any change to either side
// should be made in both.

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

/** Mirrors the browser's `encryptTeamMap`. */
async function encryptTeamMap(
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
    const envelope = await encryptTeamMap(teamKeyRaw, { __CLS__1: 'Invoice' })

    const bobPrivate = await unwrapPrivateKey(bobVault as unknown as CryptoKeyLike, bobStoredPrivate)
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
    const env = await encryptTeamMap(teamKeyRaw, { __CLS__1: 'Invoice' })
    const key = await subtle.importKey('raw', buf(teamKeyRaw), { name: WRAP_ALG }, false, ['decrypt'])

    await expect(
      decryptTeamMap(key as unknown as CryptoKeyLike, {
        ...env,
        alg: 'AES-256-GCM-PBKDF2' as TeamMapEnvelope['alg'],
      })
    ).rejects.toThrow(/Unsupported team map envelope/)
  })

  it('refuses altered ciphertext rather than returning nonsense identifiers', async () => {
    const teamKeyRaw = randomTeamKey()
    const env = await encryptTeamMap(teamKeyRaw, { __CLS__1: 'Invoice' })
    const key = await subtle.importKey('raw', buf(teamKeyRaw), { name: WRAP_ALG }, false, ['decrypt'])
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

    const writtenUnderV1 = await encryptTeamMap(v1Raw, { __CLS__1: 'Old' })
    const writtenUnderV2 = await encryptTeamMap(v2Raw, { __CLS__2: 'New' })

    await expect(decryptTeamMapWithAny(held, writtenUnderV1)).resolves.toEqual({ __CLS__1: 'Old' })
    await expect(decryptTeamMapWithAny(held, writtenUnderV2)).resolves.toEqual({ __CLS__2: 'New' })
  })

  it('reports every version tried when none fit', async () => {
    const held = [
      { version: 1, key: await keyOf(randomTeamKey()) },
      { version: 2, key: await keyOf(randomTeamKey()) },
    ]
    const foreign = await encryptTeamMap(randomTeamKey(), { __CLS__1: 'Invoice' })

    await expect(decryptTeamMapWithAny(held, foreign)).rejects.toThrow(/tried v2, v1/)
  })

  it('says so plainly when no key is held at all', async () => {
    const env = await encryptTeamMap(randomTeamKey(), {})
    await expect(decryptTeamMapWithAny([], env)).rejects.toThrow(/No team key is held/)
  })
})
