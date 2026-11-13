// One writer for the 0600 JSON files under ~/.veilio (spec 093 item 12): the
// credential, the cached rules, the unlocked keys and the key pins each had
// their own, and only one of the five wrote beside and renamed.

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Write `value` as JSON, readable only by this user.
 *
 * Written beside, then renamed over: a reader sees the old file or the new
 * one, never half, and a crash mid-write leaves the old one. The file is new
 * each time, so one left world-readable by an earlier mistake never holds the
 * new content; `chmodSync` because `mode` applies only when the file is
 * created, and a leftover of this name may not have been ours.
 */
export function writeSecretJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}
