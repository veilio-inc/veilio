// Founder decision (Cloud audit M1): a custom rule's placeholder base names
// what a team considers sensitive (`__ACME_ACQUISITION_TARGET__`), so it never
// reaches the server in plain text. Reserving numbers for one sends an HMAC of
// it under the team key instead; the engine's own bases go as they are.
// Everything on this machine - the map, reserved.json - keeps the real base.
import { createHmac } from 'node:crypto'
import { fromBase64, isEngineBase } from '@veilio-inc/engine'
import type { Credential } from './credential.js'
import { readTeamUnlock, writeKeyOf } from './team-unlock.js'
import { printable } from './reservations.js'

/** The base as the server sees it: `__H_<16 hex>__` for a rule's base. */
export function wireBase(base: string, teamKey: Uint8Array): string {
  if (isEngineBase(base)) return base
  const mac = createHmac('sha256', teamKey).update(base, 'utf8').digest('hex')
  return `__H_${mac.slice(0, 16).toUpperCase()}__`
}

/** The raw team keys a rule's name may be hashed under, newest first: none
 *  unless the newest is confirmed (`writeKeyOf`), and never one that is not
 *  (spec 080 item 7a) - a hash under a key the server made tells it the name. */
export function teamKeyBytes(
  credential: Pick<Credential, 'instance' | 'account'>,
  home: string | undefined,
  teamId: string
): Uint8Array[] {
  return heldKeys(credential, home, teamId).map((k) => k.raw)
}

/** The newest team key version this machine holds for `teamId`. */
export function teamKeyVersion(
  credential: Pick<Credential, 'instance' | 'account'>,
  home: string | undefined,
  teamId: string
): number | undefined {
  return heldKeys(credential, home, teamId)[0]?.version
}

function heldKeys(
  credential: Pick<Credential, 'instance' | 'account'>,
  home: string | undefined,
  teamId: string
): { version: number; raw: Uint8Array }[] {
  const unlock = readTeamUnlock(
    { instance: credential.instance, account: credential.account },
    home
  )
  if (!unlock || unlock.teamId !== teamId || !writeKeyOf(unlock)) return []
  const out: { version: number; raw: Uint8Array }[] = []
  for (const k of unlock.keys) {
    if (!k.writable) continue
    try {
      out.push({ version: k.version, raw: fromBase64(k.key) })
    } catch {
      continue // a damaged entry: the others may still serve
    }
  }
  return out.sort((a, b) => b.version - a.version)
}

/** The team to name when a rule's name may not be hashed because the newest
 *  key is not confirmed; null when it may, or when nothing is unlocked. */
export function teamKeyUnconfirmed(
  credential: Pick<Credential, 'instance' | 'account'>,
  home: string | undefined,
  teamId: string
): string | null {
  const unlock = readTeamUnlock(
    { instance: credential.instance, account: credential.account },
    home
  )
  if (!unlock || unlock.teamId !== teamId || writeKeyOf(unlock)) return null
  return printable(unlock.teamName ?? unlock.teamId)
}

/** Whether a base the server served (a reservation's) is `base`: as written,
 *  or its hash under any held key version - one reserved before a rotation
 *  carries the old key's hash. */
export function servedAs(served: string, base: string, keys: readonly Uint8Array[]): boolean {
  return served === base || keys.some((k) => wireBase(base, k) === served)
}
