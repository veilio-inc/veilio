// The team keys, unlocked for processes that have nobody to ask.
//
// An MCP server starts inside a coding agent. There is no terminal attached and
// no one present to type a vault passphrase, so a key it needs must have been
// put here by an earlier run in a terminal where somebody was. `veilio team
// unlock` is that run.
//
// WHAT THIS FILE HOLDS, AND WHY IT IS THE NARROWER OF TWO BAD OPTIONS
//
// It holds unwrapped TEAM keys. The obvious alternative — storing the vault key
// and re-deriving everything per process — is worse in every direction that
// matters: the vault key also opens every personal map, and unwraps the private
// key, which in turn opens any wrap ever addressed to this account, including
// ones granted after the file was written. A team key opens team maps and
// nothing else, and a team already shares them by construction.
//
// It is still real key material at rest. Whoever holds this file can read the
// team's maps until the keys rotate. It is written 0600 beside the session
// token, which is the same posture the token itself gets, and it expires — so a
// machine compromised weeks after somebody ran `unlock` does not hand over a
// live key for a forgotten session.
//
// WHAT IT DOES NOT SURVIVE
//
// A rotation. Removing a member mints a new version, and the copy here is of
// the old one, so maps rewritten under the new key stop opening. That is
// deliberate: the stale file degrades into "some maps cannot be read", which
// `decryptTeamMapWithAny` already handles by skipping them, rather than into
// continued access a rotation was meant to end. Re-running `unlock` picks up
// the new version.
//
// Reads tolerate everything, exactly as `credential.ts` does: a missing file,
// a corrupt one, an expired one and one belonging to another account all mean
// the same thing to every caller — not unlocked, resolve locally.

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { STORE_DIR } from '@veilio-inc/engine'

export const TEAM_UNLOCK_FILE = 'team-keys.json'

/** How long an unlock lasts unless asked for something shorter. */
export const DEFAULT_UNLOCK_DAYS = 7

export interface StoredTeamKey {
  version: number
  /** Raw AES-256 key, base64. */
  key: string
}

export interface TeamUnlock {
  v: 1
  /** Bound to the instance and account that unlocked it, so a file left behind
   *  by one sign-in is never used by another. The same reasoning as the wrap
   *  context: material that is valid somewhere must not be valid everywhere. */
  instance: string
  account: string
  teamId: string
  /** ISO-8601. Past this, reads return null and the file is ignored. */
  expiresAt: string
  keys: StoredTeamKey[]
}

/** Where the unlocked keys live: beside the credential, not in a project. */
export function teamUnlockPath(home: string = homedir()): string {
  return join(home, STORE_DIR, TEAM_UNLOCK_FILE)
}

function isTeamUnlock(value: unknown): value is TeamUnlock {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const u = value as Record<string, unknown>
  if (u.v !== 1) return false
  for (const field of ['instance', 'account', 'teamId', 'expiresAt'] as const) {
    if (typeof u[field] !== 'string' || u[field] === '') return false
  }
  if (!Array.isArray(u.keys) || u.keys.length === 0) return false
  return u.keys.every((k: unknown) => {
    if (typeof k !== 'object' || k === null) return false
    const key = k as Record<string, unknown>
    return typeof key.version === 'number' && typeof key.key === 'string' && key.key !== ''
  })
}

/**
 * The unlocked keys, or null.
 *
 * Null means "not unlocked", for every reason it can mean that. `now` is
 * injectable so the expiry can be tested without waiting a week.
 */
export function readTeamUnlock(
  binding: { instance: string; account: string },
  home: string = homedir(),
  now: Date = new Date()
): TeamUnlock | null {
  let raw: string
  try {
    raw = readFileSync(teamUnlockPath(home), 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isTeamUnlock(parsed)) return null

  // Someone else's unlock, or one from another instance. Not an error — a
  // machine can be signed in to a self-hosted instance today and to the hosted
  // one tomorrow, and the leftover file is simply not ours.
  if (parsed.instance !== binding.instance || parsed.account !== binding.account) return null

  const expiresAt = Date.parse(parsed.expiresAt)
  if (Number.isNaN(expiresAt) || expiresAt <= now.getTime()) return null

  return parsed
}

/** Write the unlocked keys, readable only by this user. */
export function writeTeamUnlock(unlock: TeamUnlock, home: string = homedir()): void {
  const path = teamUnlockPath(home)
  mkdirSync(dirname(path), { recursive: true })
  // `chmodSync` after the write for the same reason `writeCredential` does it:
  // `mode` applies only when the file is created, so re-unlocking over a
  // world-readable file left from an earlier mistake would keep it that way.
  writeFileSync(path, `${JSON.stringify(unlock, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/**
 * Remove the unlocked keys. Returns whether there were any to remove.
 *
 * Called by `team lock` and by `logout` — signing out must not leave live team
 * keys behind, which would be exactly the gap between what a person believes
 * they revoked and what is still readable on disk.
 *
 * A failure to DELETE throws rather than returning false, for the reason
 * `removeCredential` gives: reporting "nothing to remove" while key material
 * sits there inverts the whole point of the call.
 */
export function removeTeamUnlock(home: string = homedir()): boolean {
  const path = teamUnlockPath(home)
  try {
    statSync(path)
  } catch {
    return false
  }
  rmSync(path, { recursive: true, force: true })
  return true
}

/** When an unlock made now should expire. */
export function expiryFrom(now: Date, days: number = DEFAULT_UNLOCK_DAYS): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
}
