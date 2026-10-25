// `veilio vault unlock` and `vault lock`: the personal-maps key on this machine
// (spec 052 FR-011, research §1 and §8).
//
// Unlock asks for the passphrase ONCE, derives the vault key in memory, and
// uses it for exactly two things before it is dropped:
//
//   1. to unwrap the account's personal-maps key - or, the first time, to wrap
//      a new one for the server to keep;
//   2. to re-seal the account's older personal maps, still under the vault
//      key, under the personal-maps key - the only moment a terminal holds both.
//
// Then only the personal-maps key is written, 0600, with an expiry. The vault
// key is non-extractable and is never written anywhere; the passphrase is not
// either. A passphrase-less process - the MCP server - can then open personal
// maps, and nothing else the vault protects.

import {
  checkVaultVerifier,
  decryptMapFromVault,
  deriveVaultKey,
  encryptMapForVault,
  fromBase64,
  parseVaultEnvelope,
  toBase64,
  type CryptoKeyLike,
} from '@veilio-inc/engine'
import {
  CloudError,
  getMap,
  getPersonalMapsKeyWrap,
  getVault,
  listMaps,
  putPersonalMapsKeyWrap,
  updateMapContent,
} from '../cloud.js'
import { readCredential, type Credential } from '../credential.js'
import { expiryFrom } from '../team-unlock.js'
import {
  importPersonalMapsKey,
  newPersonalMapsKey,
  personalMapsKeyPath,
  removePersonalMapsKey,
  unwrapPersonalMapsKey,
  wrapPersonalMapsKey,
  writePersonalMapsKey,
} from './personal-maps-key.js'
import { refuse, refusalFromCloudError, type Outcome } from './wording.js'
import type { ClientContext } from './maps.js'

export interface VaultUnlocked {
  path: string
  expiresAt: string
  /** This unlock made the account's personal-maps key (the first one). */
  created: boolean
  /** Older personal maps re-sealed under it now. */
  resealed: number
  /** Ones that could not be, by id and name, with the reason. */
  failed: { id: string; name: string; reason: string }[]
}

export async function vaultUnlock(
  ctx: ClientContext,
  opts: { days?: number } = {}
): Promise<Outcome<VaultUnlocked>> {
  const credential = readCredential(ctx.home)
  if (!credential) return refuse('not_signed_in')
  if (!ctx.passphrase) return refuse('no_passphrase')
  const fail = (err: unknown) => ({
    ok: false as const,
    refusal: refusalFromCloudError(err, { project: credential.project }),
  })

  let vault
  try {
    vault = await getVault(credential)
  } catch (err) {
    return fail(err)
  }
  if (!vault.initialized) return refuse('no_vault')
  const passphrase = await ctx.passphrase()
  if (passphrase === '') return refuse('no_passphrase')
  const vaultKey = await deriveVaultKey(
    passphrase,
    fromBase64(vault.salt),
    vault.kdf ? { name: 'PBKDF2-SHA256', iterations: vault.kdf.iterations } : undefined
  )
  // Before anything is created, uploaded or written: a key wrapped under the
  // wrong passphrase would be stored for good (PUT never replaces one).
  if (!(await checkVaultVerifier(vaultKey, vault.verifier))) return refuse('wrong_passphrase')

  let raw: Uint8Array
  let created = false
  try {
    const held = (await getPersonalMapsKeyWrap(credential)).wrapped
    if (typeof held === 'string' && held !== '') {
      const opened = await unwrapped(vaultKey, held)
      if (!opened) return refuse('pmk_unopenable')
      raw = opened
    } else {
      const fresh = newPersonalMapsKey()
      try {
        await putPersonalMapsKeyWrap(credential, await wrapPersonalMapsKey(vaultKey, fresh))
        raw = fresh
        created = true
      } catch (err) {
        // Another client - a browser tab, a second terminal - stored one
        // between our read and our write. Its key wins: maps may already be
        // sealed under it, and replacing it is exactly what the server's 409
        // exists to stop. Ours was never used for anything.
        if (!(err instanceof CloudError && err.status === 409)) return fail(err)
        const theirs = (await getPersonalMapsKeyWrap(credential)).wrapped
        const opened = typeof theirs === 'string' ? await unwrapped(vaultKey, theirs) : null
        if (!opened) return refuse('pmk_unopenable')
        raw = opened
      }
    }
  } catch (err) {
    return fail(err)
  }

  const expiresAt = expiryFrom(new Date(), opts.days)
  writePersonalMapsKey(
    {
      v: 1,
      instance: credential.instance,
      account: credential.account,
      expiresAt,
      key: toBase64(raw),
    },
    ctx.home
  )

  const pmk = await importPersonalMapsKey(raw)
  const resealing = await reseal(credential, vaultKey, pmk)
  return {
    ok: true,
    value: {
      path: personalMapsKeyPath(ctx.home),
      expiresAt,
      created,
      resealed: resealing.resealed,
      failed: resealing.failed,
    },
  }
}

async function unwrapped(vaultKey: CryptoKeyLike, wrapped: string): Promise<Uint8Array | null> {
  try {
    return await unwrapPersonalMapsKey(vaultKey, wrapped)
  } catch {
    return null
  }
}

/**
 * Re-seal every personal map still under the vault key, while it is in hand.
 *
 * One at a time, each with the version it read, so a map changed meanwhile is
 * reported rather than overwritten. A failure stops nothing else: each map
 * that did not move is named, and running unlock again picks it up.
 */
async function reseal(
  credential: Credential,
  vaultKey: CryptoKeyLike,
  pmk: CryptoKeyLike
): Promise<{ resealed: number; failed: VaultUnlocked['failed'] }> {
  const failed: VaultUnlocked['failed'] = []
  let resealed = 0
  let personal
  try {
    personal = (await listMaps(credential)).personalMaps.filter((m) => m.scope === 'personal')
  } catch (err) {
    return {
      resealed,
      failed: [
        {
          id: '-',
          name: 'the list of maps',
          reason: err instanceof Error ? err.message : String(err),
        },
      ],
    }
  }
  for (const summary of personal) {
    try {
      const full = await getMap(credential, summary.id)
      if (typeof full.map_data !== 'string') throw new Error('not an encrypted envelope')
      const envelope = parseVaultEnvelope(full.map_data)
      try {
        await decryptMapFromVault(pmk, envelope)
        continue // already under the personal-maps key
      } catch {
        // under the vault key, or damaged: the next step says which
      }
      const map = await decryptMapFromVault(vaultKey, envelope)
      await updateMapContent(credential, summary.id, {
        map_data: JSON.stringify(await encryptMapForVault(pmk, map)),
        identifier_count: Object.keys(map).length,
        if_updated_at: full.updated_at,
      })
      resealed++
    } catch (err) {
      failed.push({
        id: summary.id,
        name: summary.name,
        reason:
          err instanceof CloudError && err.status === 409
            ? 'it changed in Cloud while this ran'
            : err instanceof Error
              ? err.message
              : String(err),
      })
    }
  }
  return { resealed, failed }
}

/** Remove the personal-maps key from this machine. Whether there was one. */
export function vaultLock(ctx: ClientContext): boolean {
  return removePersonalMapsKey(ctx.home)
}
