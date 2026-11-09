// Who made a team-key wrap, and whether this CLI may WRITE under the key it
// holds (spec 080 item 7a). A port of the web app's verdict, Cloud
// `frontend/src/lib/wrapTrust.ts` (spec 055 R-007), for a client with nobody
// to ask.
//
// A wrap's `from` is its granter's public key, and decrypting it proves only
// that whoever holds that key made it. So a server that made a wrap with its
// own key could hand it over labelled as ours, or as a teammate's, and it
// would open. What this device knows about a key decides:
//
// 1. `from` unreadable                         -> `unreadable` (not stored)
// 2. `from` is our own derived key             -> `trusted`
// 3. labelled as ours, `from` is not           -> `refused-impersonation`
// 4. the granter's identity: `wrapped_by`, or `key:<from>` when the granter
//    is the deleted-account sentinel or not named
// 5. their confirmed keys: the current one, then the history
// 6. `from` is one of them                     -> `trusted`
// 7. they exist and `from` is none of them     -> `refused-change`
// 8. no confirmed key for them                 -> `needs-review` (read-only)
//
// Team membership is not an input, as in the web app's verdict. The web app
// also keeps a first-sighting (`auto`) kind of pin and a removed member's
// bound; the CLI writes pins only from a person's confirmation and reads no
// member list, so neither applies here.

import type { KeyPins } from '../key-pins.js'
import { confirmedKeys, pinOf } from '../key-pins.js'

export type WrapVerdict =
  'trusted' | 'needs-review' | 'refused-change' | 'refused-impersonation' | 'unreadable'

/** The deleted-account sentinel the server writes into `wrapped_by` on erasure. */
export const DELETED_GRANTER = 'deleted-user'

export interface JudgeInput {
  /** The wrap's granter key (`wrapFrom`); undefined when it names none. */
  from: string | undefined
  /** The server's `wrapped_by`: a user id, the sentinel, or absent. */
  wrappedBy: string | undefined
  /** Derived from our own private key, never the server's copy. */
  ownPublicKey: string
  /** Our own user id, for rule 3. */
  ownId: string
  pins: KeyPins
}

export interface Judged {
  verdict: WrapVerdict
  /** What a confirmation is recorded under: a user id, or `key:<publicKey>`. */
  identity?: string
  /** The key the wrap was made with: what a person is asked to confirm. */
  offered?: string
  /** For `refused-change`: the confirmed key it differs from. */
  pinned?: string
}

/** The granter key a stored wrap names, or undefined. */
export function wrapFrom(wrappedKey: string): string | undefined {
  try {
    const from = (JSON.parse(wrappedKey) as { from?: unknown }).from
    return typeof from === 'string' && from !== '' ? from : undefined
  } catch {
    return undefined
  }
}

/** The identity a wrap's confirmation lives under (rule 4). */
export function granterIdentity(from: string, wrappedBy: string | null | undefined): string {
  return wrappedBy === undefined || wrappedBy === null || wrappedBy === DELETED_GRANTER
    ? `key:${from}`
    : wrappedBy
}

export function judgeWrap({ from, wrappedBy, ownPublicKey, ownId, pins }: JudgeInput): Judged {
  if (!from) return { verdict: 'unreadable' }
  if (from === ownPublicKey) return { verdict: 'trusted' }
  if (wrappedBy === ownId) return { verdict: 'refused-impersonation' }
  const identity = granterIdentity(from, wrappedBy)
  const confirmed = confirmedKeys(pinOf(pins, identity))
  if (confirmed.includes(from)) return { verdict: 'trusted', identity, offered: from }
  if (confirmed.length > 0)
    return { verdict: 'refused-change', identity, pinned: confirmed[0], offered: from }
  return { verdict: 'needs-review', identity, offered: from }
}
