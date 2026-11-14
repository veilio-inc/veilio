// The teammate keys this member confirmed by fingerprint, on this device
// (spec 080 item 7a; the web app's keyPinning.ts and its research R-011).
//
// A team key's wrap names the key it was made with, and decrypting it proves
// only that whoever holds that key made it - so a server could make one with
// its own key and label it as a teammate's. A pin is what a person checked
// outside Veilio: `veilio team trust` writes one after the fingerprints were
// compared. Nothing here is ever sent to the server, encrypted or not: a pin
// the server could read or replace would protect against nothing.
//
// Unlike the web app's, every pin here is confirmed: the CLI never records a
// first sighting, so there is no `auto` kind to tell apart.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { STORE_DIR } from '@veilio-inc/engine'
import { writeSecretJson } from './secret-file.js'

export const KEY_PINS_FILE = 'key-pins.json'

export interface KeyPin {
  /** The confirmed public key, base64. */
  current: string
  /** Earlier confirmed keys of the same person, so what they granted with
   *  those stays trusted after an honest key reset. */
  history: string[]
  /** ISO-8601. */
  confirmedAt: string
}

/** By granter user id, or `key:<publicKey>` for a granter with no account. */
export type KeyPins = Record<string, KeyPin>

interface Binding {
  instance: string
  account: string
}

interface Scope extends Binding {
  pins: KeyPins
  /**
   * Per team id: the highest team-key version Cloud offered this account that
   * `team unlock` did not store (spec 080 review). A high-water mark: kept
   * here, beside the pins, so it outlives logout and `team lock`, and a later
   * answer that leaves the version out cannot lower it.
   */
  blocked?: Record<string, number>
}

interface PinsFile {
  v: 1
  scopes: Scope[]
}

/** key-pins.json exists and is not one this CLI can read: never overwritten,
 *  since confirmations a person made are in there. */
export class KeyPinsDamaged extends Error {
  constructor(readonly path: string) {
    super(`${path} is damaged`)
  }
}

export function keyPinsPath(home: string = homedir()): string {
  return join(home, STORE_DIR, KEY_PINS_FILE)
}

function isPin(p: unknown): p is KeyPin {
  if (typeof p !== 'object' || p === null) return false
  const pin = p as Record<string, unknown>
  return (
    typeof pin.current === 'string' &&
    pin.current !== '' &&
    Array.isArray(pin.history) &&
    pin.history.every((k) => typeof k === 'string') &&
    typeof pin.confirmedAt === 'string'
  )
}

/** The file, or null when it exists and is not one this CLI wrote. */
function readFile(home: string): PinsFile | null {
  let text: string
  try {
    text = readFileSync(keyPinsPath(home), 'utf8')
  } catch (err) {
    // Only a file that is not there is "none yet". One that cannot be read
    // (a directory, another owner, an I/O error) still holds what a person
    // confirmed: damaged, so nothing replaces it.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, scopes: [] }
    return null
  }
  try {
    const parsed = JSON.parse(text) as PinsFile
    if (parsed?.v === 1 && Array.isArray(parsed.scopes)) return parsed
  } catch {
    // not JSON
  }
  return null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** This instance and account's pins. A damaged entry is left out. */
export function readPins(binding: Binding, home: string = homedir()): KeyPins {
  const file = readFile(home)
  const scope = file ? findScope(file, binding) : undefined
  // No prototype: a granter id is the server's word, and `__proto__` or
  // `constructor` must be a key like any other, never Object's own.
  const pins: KeyPins = Object.create(null)
  for (const [id, pin] of Object.entries(scope?.pins ?? {})) if (isPin(pin)) pins[id] = pin
  return pins
}

/** The pin for `identity`, only if one was recorded under exactly that. */
export function pinOf(pins: KeyPins, identity: string): KeyPin | undefined {
  return Object.hasOwn(pins, identity) ? pins[identity] : undefined
}

/** The keys a pin accepts: the current one, then the earlier ones. */
export function confirmedKeys(pin: KeyPin | undefined): string[] {
  return pin ? [pin.current, ...pin.history] : []
}

/** Record `publicKey` as confirmed for `identity`, keeping any earlier one. */
export function confirmPin(
  binding: Binding,
  identity: string,
  publicKey: string,
  home: string = homedir(),
  now: Date = new Date()
): void {
  update(binding, home, (scope) => {
    const held = pinOf(scope.pins, identity)
    const before = isPin(held) ? held : undefined
    const history = confirmedKeys(before).filter((k) => k !== publicKey)
    scope.pins[identity] = { current: publicKey, history, confirmedAt: now.toISOString() }
  })
}

/** This account's blocked version for `teamId`, or undefined. Throws
 *  `KeyPinsDamaged` when it cannot be known: the caller then writes nothing. */
export function blockedMark(
  binding: Binding,
  teamId: string,
  home: string = homedir()
): number | undefined {
  const file = readFile(home)
  if (!file) throw new KeyPinsDamaged(keyPinsPath(home))
  const scope = findScope(file, binding)
  if (!scope || scope.blocked === undefined) return undefined
  if (!isRecord(scope.blocked)) throw new KeyPinsDamaged(keyPinsPath(home))
  if (!Object.hasOwn(scope.blocked, teamId)) return undefined
  const mark = scope.blocked[teamId]
  if (typeof mark !== 'number') throw new KeyPinsDamaged(keyPinsPath(home))
  return mark
}

/**
 * Settle the blocked version for `teamId` against what is stored NOW, in one
 * read-change-write: first `clearUpTo` drops the mark only if it is still at
 * most that (the value this run read - a raise another unlock made since is
 * kept), then `raise` keeps the higher of the two. The mark it leaves.
 */
export function settleBlockedMark(
  binding: Binding,
  teamId: string,
  change: { clearUpTo?: number; raise?: number },
  home: string = homedir()
): number | undefined {
  let left: number | undefined
  update(binding, home, (scope) => {
    const blocked = scope.blocked!
    let mark = Object.hasOwn(blocked, teamId) ? blocked[teamId] : undefined
    if (change.clearUpTo !== undefined && mark !== undefined && mark <= change.clearUpTo)
      mark = undefined
    if (change.raise !== undefined) mark = Math.max(mark ?? change.raise, change.raise)
    if (mark === undefined) delete blocked[teamId]
    else blocked[teamId] = mark
    left = mark
  })
  return left
}

function findScope(file: PinsFile, binding: Binding): Scope | undefined {
  return file.scopes.find((s) => s?.instance === binding.instance && s?.account === binding.account)
}

/** Read, change this account's scope, write back atomically at 0600. A damaged
 *  file, or a damaged scope of this account, is refused and left as it is. */
function update(binding: Binding, home: string, change: (scope: Scope) => void): void {
  const file = readFile(home)
  let scope = file ? findScope(file, binding) : undefined
  if (
    !file ||
    (scope && !isRecord(scope.pins)) ||
    (scope?.blocked !== undefined &&
      !(
        isRecord(scope.blocked) && Object.values(scope.blocked).every((m) => typeof m === 'number')
      ))
  )
    throw new KeyPinsDamaged(keyPinsPath(home))
  if (!scope) {
    scope = { instance: binding.instance, account: binding.account, pins: {} }
    file.scopes.push(scope)
  }
  // No prototype: ids are the server's words (`__proto__` is a key here).
  scope.pins = Object.assign(Object.create(null) as KeyPins, scope.pins)
  scope.blocked = Object.assign(Object.create(null) as Record<string, number>, scope.blocked)
  change(scope)

  // Written beside, then renamed over: a crash mid-write must not leave a
  // half file that reads as "no pins" and silently drops every confirmation.
  writeSecretJson(keyPinsPath(home), file)
}
