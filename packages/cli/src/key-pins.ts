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

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { STORE_DIR } from '@veilio-inc/engine'

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

interface PinsFile {
  v: 1
  scopes: (Binding & { pins: KeyPins })[]
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
  } catch {
    return { v: 1, scopes: [] } // none yet
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
  const scope = (readFile(home)?.scopes ?? []).find(
    (s) => s?.instance === binding.instance && s?.account === binding.account
  )
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
  const file = readFile(home)
  let scope = file?.scopes.find(
    (s) => s?.instance === binding.instance && s?.account === binding.account
  )
  // Never overwritten: confirmations a person made are in there, and a file
  // this CLI cannot read is for that person to look at, not to replace.
  if (!file || (scope && !isRecord(scope.pins)))
    throw new Error(
      `${keyPinsPath(home)} is damaged, so the key was not confirmed. Move it aside and run \`veilio team trust\` again.`
    )
  if (!scope) {
    scope = { instance: binding.instance, account: binding.account, pins: {} }
    file.scopes.push(scope)
  }
  scope.pins = Object.assign(Object.create(null) as KeyPins, scope.pins)
  const held = pinOf(scope.pins, identity)
  const before = isPin(held) ? held : undefined
  const history = confirmedKeys(before).filter((k) => k !== publicKey)
  scope.pins[identity] = { current: publicKey, history, confirmedAt: now.toISOString() }

  const path = keyPinsPath(home)
  mkdirSync(dirname(path), { recursive: true })
  // Written beside, then renamed over: a crash mid-write must not leave a
  // half file that reads as "no pins" and silently drops every confirmation.
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}
