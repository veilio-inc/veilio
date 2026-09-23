// Opening a team map: the read half of the team-key scheme.
//
// A team map is encrypted under a TEAM key that every member holds, and each
// member holds it wrapped to their own public key. Getting from a passphrase to
// a readable map is three unwraps:
//
//   vault key (passphrase)  ->  private key  ->  team key  ->  the map
//
// Only the read direction lives here. Minting a team key, granting it to a
// teammate, and confirming a teammate's key are the write half, they need a
// person present to approve them, and they stay in the browser. A client that
// can open maps has no business being able to hand out access to them.
//
// Ported from `veilio-cloud`'s frontend so the MCP server can do what the
// browser does: merge the team namespace itself, over maps only it can open,
// rather than asking a server to decrypt them on its behalf. The server having
// that ability was the one reason it held a key that could read team maps.

import { fromBase64, toBase64, webCryptoSubtle } from './envelope.js'
import type { CryptoKeyLike } from './vault.js'

const WRAP_ALG = 'AES-GCM'

/** The asymmetric algorithm a user's keypair uses. */
export const USER_KEY_ALG = 'X25519' as const

/** Tag on a team map at rest.
 *
 *  Deliberately NOT the vault envelope's tag. That one is AES-256-GCM-PBKDF2,
 *  and a team key comes from ECDH + HKDF rather than a passphrase — reusing the
 *  tag would tell a future reader that one person's passphrase loss takes the
 *  map with it, which is the opposite of how a team key behaves. Checked on the
 *  way in, so the two schemes cannot be confused silently. */
const TEAM_ENVELOPE_ALG = 'AES-256-GCM-TEAM' as const

export class TeamKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamKeyError'
  }
}

/** A user's private key at rest, wrapped under their vault key. */
interface WrapEnvelope {
  v: 1
  alg: typeof WRAP_ALG
  iv: string
  data: string
}

/** One member's copy of a team key, wrapped to their public key. */
interface Wrap {
  v: 1
  iv: string
  data: string
  /** Base64 public key of whoever granted it. Needed to rebuild the context. */
  from: string
}

/** A team map at rest, inside Veilio's outer layer. */
export interface TeamMapEnvelope {
  v: 1
  alg: typeof TEAM_ENVELOPE_ALG
  iv: string
  data: string
}

/**
 * The context a wrapping key is bound to.
 *
 * Without this, `deriveWrappingKey(alicePriv, bobPub)` produced the SAME key
 * for every team and every version — so a wrap addressed to Bob in team A
 * decrypted verbatim when re-filed as team B, or as a later version. Two things
 * followed: team B's maps could be encrypted under team A's key with nobody
 * seeing an anomaly, and a v1 wrap copied into a v2 row would hand a removed
 * member the old key while their client believed it was the new one — defeating
 * the rotation that removal exists to trigger.
 *
 * Both parties can reconstruct this independently: the granter knows all four
 * fields, and the recipient reads teamId and version from the row, the
 * granter's key from the wrap itself, and supplies their own.
 */
export interface WrapContext {
  teamId: string
  version: number
  /** Base64 public key of whoever is granting. */
  granterPublicKey: string
  /** Base64 public key of whoever receives. */
  recipientPublicKey: string
}

function contextInfo(ctx: WrapContext): Uint8Array {
  // Length-prefixed rather than delimiter-joined: a team id containing the
  // separator would otherwise let two different contexts encode identically.
  const parts = [
    'veilio-team-key-wrap-v2',
    ctx.teamId,
    String(ctx.version),
    ctx.granterPublicKey,
    ctx.recipientPublicKey,
  ]
  return new TextEncoder().encode(parts.map((p) => `${p.length}:${p}`).join(''))
}

/** Import a teammate's public key from its stored base64 form. */
export async function importPublicKey(publicKeyBase64: string): Promise<CryptoKeyLike> {
  let raw: Uint8Array
  try {
    raw = fromBase64(publicKeyBase64)
  } catch {
    throw new TeamKeyError('Public key is not valid base64')
  }
  if (raw.byteLength !== 32) {
    throw new TeamKeyError(
      `Public key must be 32 bytes for ${USER_KEY_ALG} (got ${raw.byteLength}). ` +
        `Refusing it rather than deriving a shared secret from something else.`
    )
  }
  return webCryptoSubtle().importKey('raw', raw, { name: USER_KEY_ALG }, true, [])
}

/**
 * Recover the private key. Throws if the vault key is wrong or the blob is
 * damaged.
 *
 * The private half is stored wrapped under the vault key — derived from a
 * passphrase the server never receives — so what the server holds is a blob it
 * cannot open, exactly like a personal map envelope. Lose the passphrase and
 * you lose the private key, and with it every team key wrapped to it. That is
 * the contract, not a gap.
 */
export async function unwrapPrivateKey(
  vaultKey: CryptoKeyLike,
  privateKeyEncrypted: string
): Promise<CryptoKeyLike> {
  let envelope: WrapEnvelope
  try {
    envelope = JSON.parse(privateKeyEncrypted) as WrapEnvelope
  } catch {
    throw new TeamKeyError('Stored private key is not a valid envelope')
  }
  if (envelope.v !== 1 || envelope.alg !== WRAP_ALG) {
    throw new TeamKeyError('Unsupported private-key envelope')
  }

  // AES-GCM authenticates, so a wrong vault key surfaces here as a failure
  // rather than as a key made of garbage that fails much later and confusingly.
  let pkcs8: ArrayBuffer
  try {
    pkcs8 = await webCryptoSubtle().decrypt(
      { name: WRAP_ALG, iv: fromBase64(envelope.iv) },
      vaultKey,
      fromBase64(envelope.data)
    )
  } catch {
    throw new TeamKeyError(
      'The stored private key could not be opened with this vault key. The passphrase ' +
        'is wrong, or the stored blob has been altered.'
    )
  }

  return webCryptoSubtle().importKey('pkcs8', pkcs8, { name: USER_KEY_ALG }, false, ['deriveBits'])
}

/**
 * Derive the symmetric key used to wrap a team key for one recipient.
 *
 * ECDH gives a shared secret, not a key — so it goes through HKDF rather than
 * being used directly. The info string binds the result to this exact
 * (team, version, granter, recipient), so a wrap moved to any other context
 * fails its authentication tag instead of opening.
 */
export async function deriveWrappingKey(
  privateKey: CryptoKeyLike,
  peerPublicKey: CryptoKeyLike,
  ctx: WrapContext
): Promise<CryptoKeyLike> {
  const subtle = webCryptoSubtle()
  const shared = await subtle.deriveBits(
    { name: USER_KEY_ALG, public: peerPublicKey },
    privateKey,
    256
  )
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: contextInfo(ctx),
    },
    material,
    { name: WRAP_ALG, length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** Open one member's wrap and recover the team key inside it. */
export async function unwrapTeamKey(
  wrapJson: string,
  myPrivateKey: CryptoKeyLike,
  ctx: { teamId: string; version: number; myPublicKey: string }
): Promise<CryptoKeyLike> {
  let wrap: Wrap
  try {
    wrap = JSON.parse(wrapJson) as Wrap
  } catch {
    throw new TeamKeyError('Team key wrap is not valid JSON')
  }
  if (wrap.v !== 1 || !wrap.iv || !wrap.data || !wrap.from) {
    throw new TeamKeyError('Unsupported team key wrap')
  }

  const granter = await importPublicKey(wrap.from)
  const wrappingKey = await deriveWrappingKey(myPrivateKey, granter, {
    teamId: ctx.teamId,
    version: ctx.version,
    granterPublicKey: wrap.from,
    recipientPublicKey: ctx.myPublicKey,
  })

  // AES-GCM authenticates, so a wrap made for someone else, or made with a
  // substituted key, fails here rather than yielding a team key made of noise
  // that would surface much later as maps nobody can open.
  let raw: ArrayBuffer
  try {
    raw = await webCryptoSubtle().decrypt(
      { name: WRAP_ALG, iv: fromBase64(wrap.iv) },
      wrappingKey,
      fromBase64(wrap.data)
    )
  } catch {
    throw new TeamKeyError(
      'This team key wrap could not be opened. It may have been created for a different ' +
        'account, for a different team or key version, or with a key that has since changed.'
    )
  }

  return webCryptoSubtle().importKey('raw', raw, { name: WRAP_ALG, length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
}

/**
 * The raw team key, base64, so a client can hold it between processes.
 *
 * This exists for one caller: an MCP server starts inside a coding agent with
 * nobody present to type a passphrase, so the key it needs has to have been put
 * somewhere by an earlier, interactive run. Exporting the TEAM key rather than
 * the vault key is the narrower choice of the two — it opens team maps and
 * nothing else, where the vault key would also open every personal map and
 * unwrap the private key that can open any wrap addressed to this account.
 *
 * Whatever holds the result holds the team's maps. That is a real cost and the
 * caller is responsible for it: `packages/cli/src/team-unlock.ts` writes it
 * 0600 beside the session token, with an expiry, and says so.
 */
export async function exportTeamKey(key: CryptoKeyLike): Promise<string> {
  return toBase64(await webCryptoSubtle().exportKey('raw', key))
}

/** The reverse, for a client reading one back off disk. */
export async function importTeamKey(rawBase64: string): Promise<CryptoKeyLike> {
  const raw = fromBase64(rawBase64)
  if (raw.byteLength !== 32) {
    throw new TeamKeyError(
      `A team key must be 32 bytes (got ${raw.byteLength}). Refusing it rather than ` +
        `importing something that would fail later as maps nobody can open.`
    )
  }
  return webCryptoSubtle().importKey('raw', raw, { name: WRAP_ALG, length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
}

/** Open a team map with the team key held. */
export async function decryptTeamMap(
  teamKey: CryptoKeyLike,
  env: TeamMapEnvelope
): Promise<Record<string, string>> {
  if (env.v !== 1 || env.alg !== TEAM_ENVELOPE_ALG) {
    throw new TeamKeyError(
      `Unsupported team map envelope (v=${String(env.v)}, alg=${String(env.alg)}).`
    )
  }

  let plaintext: ArrayBuffer
  try {
    plaintext = await webCryptoSubtle().decrypt(
      { name: WRAP_ALG, iv: fromBase64(env.iv) },
      teamKey,
      fromBase64(env.data)
    )
  } catch {
    // AES-GCM authenticates, so this is a wrong key or altered bytes — not a
    // map full of noise that would surface later as nonsense identifiers.
    throw new TeamKeyError('This team map could not be opened with the team key held.')
  }

  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, string>
}

/**
 * Open a team map with whichever held key fits.
 *
 * Mid-rotation a team's maps sit under two versions at once: the ones already
 * rewritten under the new key, and the ones not yet reached. A member holds both
 * wraps, and has no way to tell from the envelope which key a given map wants —
 * the envelope carries a *schema* version, not a key version.
 *
 * Rather than stamp the key version into the envelope, this trials each held key
 * newest-first. AES-GCM authenticates, so a wrong key fails cleanly instead of
 * returning plausible nonsense — the same property `decryptTeamMap` already
 * relies on. That makes trial decryption exact rather than a guess, and avoids a
 * format field whose absence would have needed a "treat missing as v1" rule:
 * precisely the legacy branch that outlives the thing it was written for.
 *
 * Newest-first because during a rotation most maps are already rewritten, and
 * because a map that opens under two versions cannot exist — the keys differ.
 */
export async function decryptTeamMapWithAny(
  keys: readonly { version: number; key: CryptoKeyLike }[],
  env: TeamMapEnvelope
): Promise<Record<string, string>> {
  if (keys.length === 0) {
    throw new TeamKeyError('No team key is held, so this map cannot be opened.')
  }

  const ordered = [...keys].sort((a, b) => b.version - a.version)
  for (const { key } of ordered) {
    try {
      return await decryptTeamMap(key, env)
    } catch {
      // Try the next version. A genuinely corrupt or foreign envelope falls out
      // of the loop below with the same error a single-key attempt would give.
      continue
    }
  }

  throw new TeamKeyError(
    `This team map could not be opened with any team key held ` +
      `(tried ${ordered.map((k) => `v${k.version}`).join(', ')}).`
  )
}
