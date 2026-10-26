// The team's FIRST key, minted here when the team has none (spec 052 FR-016).
//
// Somebody has to mint it, and it cannot be the server: by design it holds no
// team key and could not make one that meant anything. The web app does it for
// the first owner or admin who opens it (frontend `bootstrapTeamKey.ts`). A
// solo developer's team of one may never get there: with no maps the web app
// no longer asks for the vault, so no key was ever minted, and `team unlock`
// sent them to ask a teammate who does not exist (staging, 2026-10-26).
//
// So `team unlock`, which holds the vault key anyway, does what the browser
// does, byte for byte: a fresh 32-byte AES-GCM key, wrapped to this account's
// OWN public key with the same ECDH + HKDF context and the same
// `{v, iv, data, from}` wrap, posted as the next unused version.
//
// THE SERVER DECIDES whether it really is a bootstrap - no wraps at all, the
// next version, recipient = granter, an owner or admin. This client cannot
// check the first: `GET /key` returns only its own wraps. So it tries, and a
// refusal is the answer. Two members unlocking at once cannot both succeed; the
// loser stands down rather than mint a rival key that would strand every map
// sealed under the winner's.

import {
  deriveWrappingKey,
  exportTeamKey,
  fromBase64,
  importPublicKey,
  unwrapTeamKey,
  randomBytes,
  toBase64,
  webCryptoSubtle,
  type CryptoKeyLike,
} from '@veilio-inc/engine'
import { CloudError, getMe, getTeamKeyPending, getTeamKeyWraps, grantTeamKey } from '../cloud.js'
import type { Credential } from '../credential.js'

/** Wrap a team key for one recipient - the browser's `wrapTeamKeyFor`.
 *  `iv` is for the test vector only. */
export async function wrapTeamKeyFor(
  teamKeyRaw: Uint8Array,
  myPrivateKey: CryptoKeyLike,
  myPublicKey: string,
  recipientPublicKey: string,
  ctx: { teamId: string; version: number },
  iv: Uint8Array = randomBytes(12)
): Promise<string> {
  const wrappingKey = await deriveWrappingKey(
    myPrivateKey,
    await importPublicKey(recipientPublicKey),
    {
      teamId: ctx.teamId,
      version: ctx.version,
      granterPublicKey: myPublicKey,
      recipientPublicKey,
    }
  )
  const data = await webCryptoSubtle().encrypt({ name: 'AES-GCM', iv }, wrappingKey, teamKeyRaw)
  return JSON.stringify({ v: 1, iv: toBase64(iv), data: toBase64(data), from: myPublicKey })
}

/**
 * This account's keypair, opened with the vault key - and its public half
 * DERIVED HERE from the private half, never taken from the server.
 *
 * Why (security review): the first team key is wrapped to this account's own
 * public key. Taken as `GET /api/auth/keys` returned it, a dishonest or
 * compromised server could hand back ITS public key and be wrapped the team
 * key, which ends end-to-end confidentiality for every team map after. The
 * private key comes out of a blob only the vault key opens, so the public key
 * computed from it is the account's, whatever the server says. A server
 * answer that differs is refused, fail closed.
 */
export async function openOwnKeypair(
  vaultKey: CryptoKeyLike,
  privateKeyEncrypted: string,
  servedPublicKey: string
): Promise<
  { ok: true; privateKey: CryptoKeyLike; publicKey: string } | { ok: false; reason: 'mismatch' }
> {
  const env = JSON.parse(privateKeyEncrypted) as {
    v?: unknown
    alg?: unknown
    iv?: string
    data?: string
  }
  if (
    env.v !== 1 ||
    env.alg !== 'AES-GCM' ||
    typeof env.iv !== 'string' ||
    typeof env.data !== 'string'
  ) {
    throw new Error('the stored private key is not an envelope this client knows')
  }
  const subtle = webCryptoSubtle() as unknown as SubtleCrypto
  const pkcs8 = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(env.iv) as unknown as BufferSource },
    vaultKey as unknown as CryptoKey,
    fromBase64(env.data) as unknown as BufferSource
  )
  // Extractable only for this one export of the public half; the key used
  // from here on is imported again, non-extractable.
  const exportable = await subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, true, [
    'deriveBits',
  ])
  const jwk = await subtle.exportKey('jwk', exportable)
  if (typeof jwk.x !== 'string') throw new Error('the private key did not yield a public key')
  const derived = toBase64(
    fromBase64(
      jwk.x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (jwk.x.length % 4)) % 4)
    )
  )
  if (derived !== servedPublicKey) return { ok: false, reason: 'mismatch' }
  const privateKey = await subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, false, [
    'deriveBits',
  ])
  return { ok: true, privateKey: privateKey as unknown as CryptoKeyLike, publicKey: derived }
}

export type Bootstrap =
  /** Minted and granted to this account: the team's key, raw. */
  | { status: 'created'; version: number; raw: Uint8Array }
  /** The server refused: the team already has a key, or this account may not
   *  start one. `reason` is the server's own words when it gave some. */
  | { status: 'refused'; reason: string | null }
  /** Granted, but what the server hands back is not the key minted here:
   *  nothing may be sealed under it. */
  | { status: 'readback_mismatch' }

/**
 * Try to mint the team's first key. Throws only for a failure that is not an
 * answer (the network, the server's own error), which the caller reports.
 */
export async function bootstrapTeamKey(
  credential: Credential,
  teamId: string,
  me: { privateKey: CryptoKeyLike; publicKey: string }
): Promise<Bootstrap> {
  const user = await getMe(credential)
  const userId = user.user?.id
  if (typeof userId !== 'string' || userId === '') {
    throw new CloudError('server', 'the instance did not say which account this is')
  }
  // Not always 1: when the last holder of a key left, its number is leaked,
  // and the server refuses a new key under it (spec 014).
  const pending = await getTeamKeyPending(credential, teamId)
  const version = typeof pending?.nextVersion === 'number' ? pending.nextVersion : 1
  const raw = randomBytes(32)
  // Wrapped to ourselves; our own public key is not pinned (pinning is for
  // teammates). A substituted key would give a wrap we cannot open, which the
  // unwrap right after this reports at once.
  const wrapped = await wrapTeamKeyFor(raw, me.privateKey, me.publicKey, me.publicKey, {
    teamId,
    version,
  })
  try {
    await grantTeamKey(credential, teamId, { userId, version, wrappedKey: wrapped })
  } catch (err) {
    // 403: the team has wraps already, or this member may not start one.
    // 409: a wrap for this version exists. Somebody got there first.
    if (err instanceof CloudError && (err.status === 403 || err.status === 409)) {
      return { status: 'refused', reason: err.message || null }
    }
    throw err
  }
  // Read back and opened, and compared byte for byte with the key minted: the
  // proof that what the team's maps will be sealed under is this key, and not
  // one the server swapped in (security review). Anything else fails closed.
  const { wraps } = await getTeamKeyWraps(credential, teamId)
  const wrap = wraps.find((w) => w.version === version)
  if (!wrap) return { status: 'readback_mismatch' }
  try {
    const opened = await unwrapTeamKey(wrap.wrapped_key, me.privateKey, {
      teamId,
      version,
      myPublicKey: me.publicKey,
    })
    if ((await exportTeamKey(opened)) !== toBase64(raw)) return { status: 'readback_mismatch' }
  } catch {
    return { status: 'readback_mismatch' }
  }
  return { status: 'created', version, raw }
}
