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
  decryptMapFromVault,
  encryptMapForVault,
  parseVaultEnvelope,
  toBase64,
  type CryptoKeyLike,
} from '@veilio-inc/engine'
import {
  CloudError,
  getMap,
  getPersonalMapsKeyWrap,
  listMaps,
  listPersonalEnvelopes,
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
import { vaultKeyFor } from './vault-key.js'
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
  /** The pass ended early - a rate limit, a failing or unreachable instance -
   *  with this many personal maps not looked at. Running unlock again goes on. */
  stopped?: {
    reason: string
    left: number
    /** The seconds a rate limit asked for, when the reason names them. */
    wait?: number
  }
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

  const derived = await vaultKeyFor(credential, ctx.passphrase)
  if (!derived.ok) return derived
  const vaultKey = derived.value

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
        // Two 409s, told apart by code. One is an account with no keypair
        // yet: there is no race to recover from, only a step in the web app.
        if (err.body?.code === 'keys_not_set_up') return refuse('keys_not_set_up')
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
  const resealing = await reseal(credential, vaultKey, pmk, ctx.sleep ?? timer)
  return {
    ok: true,
    value: {
      path: personalMapsKeyPath(ctx.home),
      expiresAt,
      created,
      resealed: resealing.resealed,
      failed: resealing.failed,
      ...(resealing.stopped ? { stopped: resealing.stopped } : {}),
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

const timer = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** A failure of the instance as a whole, not of one map: the next request
 *  would fail the same way, so the pass ends on it. */
function endsThePass(err: unknown): err is CloudError {
  return (
    err instanceof CloudError &&
    (err.status === 429 || err.kind === 'unreachable' || (err.status ?? 0) >= 500)
  )
}

/**
 * Re-seal every personal map still under the vault key, while it is in hand.
 *
 * Which maps those are is decided here, by a trial decryption, from one
 * listing of the envelopes: a request per map, on every unlock, used up the
 * instance's request allowance for an account with many maps. Only a map that
 * needs re-sealing costs a request, written with the version that was listed,
 * so a map changed meanwhile is reported rather than overwritten.
 *
 * A rate limit that names a wait of up to a minute is waited for - once in
 * the whole pass. After that, a rate limit, a failing instance or one that
 * cannot be reached ends the pass with the number of maps left; a failure
 * that belongs to one map names it and the pass goes on. Running unlock again
 * picks up whatever did not move.
 */
async function reseal(
  credential: Credential,
  vaultKey: CryptoKeyLike,
  pmk: CryptoKeyLike,
  sleep: (ms: number) => Promise<void>
): Promise<Pick<VaultUnlocked, 'resealed' | 'failed' | 'stopped'>> {
  const failed: VaultUnlocked['failed'] = []
  let resealed = 0
  let personal
  try {
    personal = (await listMaps(credential)).personalMaps.filter((m) => m.scope === 'personal')
  } catch (err) {
    return { resealed, failed: [unlisted(err)] }
  }

  if (personal.length === 0) return { resealed, failed }

  let waited = false
  const patient = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call()
    } catch (err) {
      if (waited || !(err instanceof CloudError) || err.retryAfter === undefined) throw err
      waited = true
      await sleep(err.retryAfter * 1000)
      return call()
    }
  }

  // An instance from before the listing answers 404: one read per map then,
  // as it always was, under the same rule for stopping.
  const listed = new Map<string, { map_data: unknown; updated_at: string }>()
  try {
    for (const row of (await patient(() => listPersonalEnvelopes(credential))).maps)
      listed.set(row.id, row)
  } catch (err) {
    if (endsThePass(err)) return { resealed, failed, stopped: stop(err, personal.length) }
    if (!(err instanceof CloudError && err.status === 404)) {
      return { resealed, failed: [unlisted(err)] }
    }
  }

  for (const [i, summary] of personal.entries()) {
    try {
      // Not in the listing (an older instance, or a map it could not serve):
      // read on its own.
      const full = listed.get(summary.id) ?? (await patient(() => getMap(credential, summary.id)))
      if (typeof full.map_data !== 'string') throw new Error('not an encrypted envelope')
      const envelope = parseVaultEnvelope(full.map_data)
      try {
        await decryptMapFromVault(pmk, envelope)
        continue // already under the personal-maps key
      } catch {
        // under the vault key, or damaged: the next step says which
      }
      const map = await decryptMapFromVault(vaultKey, envelope)
      const sealed = JSON.stringify(await encryptMapForVault(pmk, map))
      await patient(() =>
        updateMapContent(credential, summary.id, {
          map_data: sealed,
          identifier_count: Object.keys(map).length,
          if_updated_at: full.updated_at,
        })
      )
      resealed++
    } catch (err) {
      if (endsThePass(err)) return { resealed, failed, stopped: stop(err, personal.length - i) }
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

/** The maps could not be listed at all: said as one entry, as it always was. */
function unlisted(err: unknown): VaultUnlocked['failed'][number] {
  return {
    id: '-',
    name: 'the list of maps',
    reason: err instanceof Error ? err.message : String(err),
  }
}

function stop(err: CloudError, left: number): NonNullable<VaultUnlocked['stopped']> {
  return {
    reason: err.message,
    left,
    ...(err.retryAfter === undefined ? {} : { wait: err.retryAfter }),
  }
}

/** Remove the personal-maps key from this machine. Whether there was one. */
export function vaultLock(ctx: ClientContext): boolean {
  return removePersonalMapsKey(ctx.home)
}
