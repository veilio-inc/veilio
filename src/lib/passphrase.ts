// The floor for an export passphrase (ROADMAP E8).
//
// A .veilio file is the one artifact that leaves the machine. Once it has, the
// passphrase is attacked offline, at whatever rate the attacker's hardware
// allows, for as long as they care to. 600,000 PBKDF2 iterations raise the cost
// of each guess; they do not help if the guess space is "the twenty passwords
// everyone uses".
//
// This is a floor, not a strength meter, and it is worth being blunt about the
// difference. It rejects choices that are bad by construction. It cannot tell
// that `correcthorse1` is a poor choice, and it does not pretend to — a green
// tick on a mediocre passphrase is worse than no tick at all, because it
// converts the user's own judgement into misplaced confidence.

/** NIST SP 800-63B puts the lever on length rather than composition rules:
 *  mandated symbol-and-digit recipes push people toward predictable
 *  substitutions without adding real entropy. Twelve is above the 8-character
 *  minimum that guidance sets, which is warranted here because the protected
 *  artifact is offline-attackable rather than rate-limited by a server. */
export const MIN_PASSPHRASE_LENGTH = 12

export class WeakPassphraseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WeakPassphraseError'
  }
}

/** Pick what to tell the reader when an export fails.
 *
 *  A rejected passphrase is the one export failure the user can act on, so it
 *  must say what was wrong instead of a flat "Export failed" that leaves them
 *  guessing at the map, the browser, or the disk.
 *
 *  Split out from the click handler for the same reason as its import
 *  counterpart: that handler calls `prompt()` and drives a download, which puts
 *  the branch out of reach of a test. */
export function exportErrorMessage(err: unknown): string {
  return err instanceof WeakPassphraseError ? err.message : 'Export failed'
}

/** Passphrases that clear the length bar and are still among the first things
 *  tried. A real blocklist has millions of entries and belongs in a downloaded
 *  dataset, not a source file; this catches the specific failure of someone
 *  padding to reach the minimum. */
const BLOCKED = new Set([
  'password1234',
  'passwordpassword',
  'qwertyuiop12',
  'qwertyuiopas',
  'letmein12345',
  'iloveyou1234',
  'welcome12345',
  'administrator',
  'changeme1234',
  'veiliopassword',
  // Counting up through the digits wraps at 9→0, so these are not "straight
  // runs" by the check below even though they are exactly as guessable. There
  // are only ten digits, which means no digit run long enough to clear the
  // length floor can ever be caught structurally — it has to be listed.
  '123456789012',
  '012345678901',
  '123456789123',
  '112233445566',
])

/** One character repeated: `aaaaaaaaaaaa`, `............` */
const SINGLE_RUN = /^(.)\1*$/u

/** A straight run up or down the alphabet or the digits, which is what padding
 *  to a length minimum usually looks like. */
function isSequential(value: string): boolean {
  // No short-input guard: this only runs after the length floor, so `value` is
  // always at least MIN_PASSPHRASE_LENGTH code points. A guard here would be
  // unreachable, and unreachable defensive code is a claim the tests cannot
  // check. Shorter input would still be handled correctly anyway — codePointAt
  // past the end gives undefined, the subtraction gives NaN, and NaN matches
  // neither step.
  const step = value.codePointAt(1)! - value.codePointAt(0)!
  if (step !== 1 && step !== -1) return false
  for (let i = 1; i < value.length; i++) {
    if (value.codePointAt(i)! - value.codePointAt(i - 1)! !== step) return false
  }
  return true
}

/**
 * Throw unless `passphrase` clears the floor for a new export.
 *
 * Deliberately not applied on import: a file written before this existed, or by
 * a colleague on an older build, must still open. Refusing to decrypt something
 * the user already holds is data loss dressed up as hardening — the same
 * reasoning that keeps LEGACY_FILE_KDF frozen.
 */
export function assertUsablePassphrase(passphrase: string): void {
  // Length in code points, not UTF-16 units: `👍` is one character to the person
  // typing it and two to `.length`, so counting units would let a shorter
  // passphrase through than the floor claims.
  const length = [...passphrase].length

  if (length < MIN_PASSPHRASE_LENGTH) {
    throw new WeakPassphraseError(
      `Use at least ${MIN_PASSPHRASE_LENGTH} characters — this file can be attacked offline once you share it.`
    )
  }
  if (passphrase.trim().length === 0) {
    throw new WeakPassphraseError('A passphrase of only spaces protects nothing.')
  }
  if (SINGLE_RUN.test(passphrase)) {
    throw new WeakPassphraseError('One repeated character is guessed immediately.')
  }

  const normalized = passphrase.toLowerCase()
  if (isSequential(normalized)) {
    throw new WeakPassphraseError('A straight run of characters is guessed immediately.')
  }
  if (BLOCKED.has(normalized)) {
    throw new WeakPassphraseError('This is one of the first passphrases an attacker tries.')
  }
}
