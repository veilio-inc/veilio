// The signed-in credential, on disk.
//
// One file per machine per instance, holding the session token the server
// issued, the account it belongs to, and the instance that issued it. It is
// never transmitted and never sent anywhere — `whoami` answers from it, which is
// why it carries the account and the instance rather than the token alone.
//
// EVERY read tolerates absence and corruption, and that is the whole design.
// This file sits underneath commands that must work for someone who has never
// heard of the Cloud edition (FR-001, FR-003). A reader that throws on a
// truncated file turns a half-written credential into a broken `veilio scrub`,
// and the person it breaks for is the one who never signed in.
//
// So there is exactly one failure mode here: "not signed in". Missing file,
// unreadable file, a directory where the file should be, invalid JSON, JSON of
// the wrong shape, an empty token — all of it reads as signed out, because every
// one of them means the same thing to the caller and none of them is worth
// stopping a local command over.

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { STORE_DIR } from '@veilio-inc/engine'

export const CREDENTIAL_FILE = 'credential.json'

export interface Credential {
  /** The session bearer token, exactly as issued. */
  token: string
  /** The email it belongs to, so `whoami` need not make a request. */
  account: string
  /** Base URL it was issued by, so a self-hosted instance is addressable. */
  instance: string
}

/**
 * Where the credential lives.
 *
 * Under the user's home directory, not the project store: a token authorises a
 * person, not a repository, and putting it beside `.veilio/map.json` would drop
 * it into whatever directory the CLI happened to run in — including, eventually,
 * one somebody commits.
 *
 * `home` is injectable so tests do not write to the real one.
 */
export function credentialPath(home: string = homedir()): string {
  return join(home, STORE_DIR, CREDENTIAL_FILE)
}

/** https, or a loopback address for local development. Nothing else. */
export function isSafeInstance(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
}

function isCredential(value: unknown): value is Credential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const c = value as Record<string, unknown>
  return (
    typeof c.token === 'string' &&
    c.token !== '' &&
    typeof c.account === 'string' &&
    c.account !== '' &&
    typeof c.instance === 'string' &&
    c.instance !== '' &&
    // A credential naming an `http://` instance would put the bearer token on
    // the wire in the clear, on every request, for ever — and self-hosted LAN
    // setups are exactly where somebody writes one by hand. Refusing to read it
    // reads as "not signed in", which is the safe direction and the one the
    // rest of this module already takes.
    isSafeInstance(c.instance)
  )
}

/**
 * The stored credential, or null.
 *
 * Null means "not signed in", and it means that for every reason a read can
 * fail. Callers get one case to handle, and no caller has to decide whether a
 * particular kind of breakage is worth reporting — none of them is.
 */
export function readCredential(home: string = homedir()): Credential | null {
  let raw: string
  try {
    raw = readFileSync(credentialPath(home), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return isCredential(parsed) ? parsed : null
}

/**
 * Write the credential, 0600.
 *
 * Called only after the server has accepted a sign-in — validate, then persist
 * (Constitution IV). A file written before the check leaves a credential behind
 * for an attempt that failed.
 *
 * `chmodSync` after the write because `mode` on `writeFileSync` applies only
 * when the file is created; without it, re-signing in over a world-readable file
 * left from some earlier mistake would leave it world-readable.
 */
export function writeCredential(credential: Credential, home: string = homedir()): void {
  const path = credentialPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/**
 * Remove the credential. Returns whether there was one to remove.
 *
 * Never throws, for the same reason reads do not: `logout` on a machine that was
 * never signed in should say so and exit cleanly, not fail. Note the ordering
 * this does NOT own — `logout` revokes server-side FIRST and only then calls
 * this, because deleting first leaves a live session the user believes is gone.
 */
export function removeCredential(home: string = homedir()): boolean {
  const path = credentialPath(home)
  try {
    statSync(path)
  } catch {
    // Genuinely not signed in. Nothing to do, and not an error.
    return false
  }
  // A failure to DELETE is a different thing entirely, and it throws.
  //
  // Returning false for both meant `logout` would print "you weren't signed in"
  // while a live bearer token sat on disk — an unsearchable parent directory, a
  // read-only mount, a file held open on Windows. That inverts FR-005 and
  // contradicts the whole reason this function is called before the file is
  // considered gone. The caller catches and reports the path.
  rmSync(path, { recursive: true, force: true })
  return true
}
