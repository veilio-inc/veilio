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
  importPublicKey,
  randomBytes,
  toBase64,
  webCryptoSubtle,
  type CryptoKeyLike,
} from '@veilio-inc/engine'
import { CloudError, getMe, getTeamKeyPending, grantTeamKey } from '../cloud.js'
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

export type Bootstrap =
  /** Minted and granted to this account: the team's key, raw. */
  | { status: 'created'; version: number; raw: Uint8Array }
  /** The server refused: the team already has a key, or this account may not
   *  start one. `reason` is the server's own words when it gave some. */
  | { status: 'refused'; reason: string | null }

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
    return { status: 'created', version, raw }
  } catch (err) {
    // 403: the team has wraps already, or this member may not start one.
    // 409: a wrap for this version exists. Somebody got there first.
    if (err instanceof CloudError && (err.status === 403 || err.status === 409)) {
      return { status: 'refused', reason: err.message || null }
    }
    throw err
  }
}
