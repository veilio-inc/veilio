import { InvalidMapError, isPlaceholder, MAP_LIMITS, sealablePlaintext } from '@veilio-inc/engine'
import type { SymbolMap } from '@veilio-inc/engine'

// The engine's own error, so a refusal of its reader is shown like one of ours.
export { InvalidMapError }

/** A decrypted `.veilio` file is authenticated, not trusted (ROADMAP E7).
 *
 *  Authentication proves the file was written by someone who knew the
 *  passphrase. In the team workflow that is the entire point - maps are meant to
 *  be shared - so it proves the author is a colleague, not that the contents are
 *  benign. Whatever a map contains is substituted into restored source, which
 *  the reader then pastes into an editor.
 *
 *  Validation cannot make an imported map safe, and this module does not pretend
 *  to. It makes a *malformed or hostile* one fail loudly at the boundary instead
 *  of quietly deforming the restore, and it bounds what a single file can cost.
 *  The residual risk - that a colleague's map maps `__FN__1` to something you
 *  did not expect - is inherent to the feature and belongs in the docs.
 */

// The upper bounds for one file are the engine's `MAP_LIMITS`, the same ones
// its own reader and the CLI use: a file written here opens there, and the
// other way round. Not security boundaries - a map under both can still be
// hostile. They stop a single file from exhausting memory in the reader's tab.
// The numbers are written the same in every browser.
export const counted = (n: number): string => n.toLocaleString('en-US')

/** Validate a decrypted map before it is allowed near a restore.
 *
 *  Keys must be placeholder-shaped, which is delegated to the engine rather than
 *  re-implemented - and which is also what refuses `__proto__`, so a hostile map
 *  cannot carry a prototype-pollution key.
 *
 *  The result is a fresh object built key by key. Returning the parsed value
 *  would mean validating one object and using another if anything about it was
 *  exotic. */
export function parseSymbolMap(raw: unknown): SymbolMap {
  if (raw === null || typeof raw !== 'object') {
    throw new InvalidMapError('This file does not contain a symbol map.')
  }
  if (Array.isArray(raw)) {
    throw new InvalidMapError('This file contains a list where a symbol map was expected.')
  }

  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAP_LIMITS.entries) {
    throw new InvalidMapError(`This map has more than ${counted(MAP_LIMITS.entries)} entries.`)
  }

  const map: SymbolMap = {}
  for (const [key, value] of entries) {
    if (!isPlaceholder(key)) {
      throw new InvalidMapError(`Not a placeholder: ${preview(key)}`)
    }
    if (typeof value !== 'string') {
      throw new InvalidMapError(`${key} does not map to text.`)
    }
    if (value.length > MAP_LIMITS.valueLength) {
      throw new InvalidMapError(
        `${key} maps to more than ${counted(MAP_LIMITS.valueLength)} characters.`
      )
    }
    map[key] = value
  }
  return map
}

/** The bytes an export encrypts, or why this map is not exported.
 *
 *  The import's check, in its own sentences, then the engine's limit on the
 *  sealed data, which the import applies before it decrypts. Not the engine's
 *  rule for what each kind of placeholder is made from: a manual mark made by
 *  an earlier version of the app may span lines or hold a tab, and files
 *  holding one keep working here. */
export function exportablePlaintext(map: SymbolMap): Uint8Array {
  try {
    return sealablePlaintext(parseSymbolMap(map))
  } catch (err) {
    if (!(err instanceof InvalidMapError)) throw err
    throw new InvalidMapError(
      `This map cannot be exported, because it could not be imported again: ${err.reason}`
    )
  }
}

/** Pick what to tell the reader when an import fails.
 *
 *  A file that decrypted but did not validate is a different failure from a
 *  wrong passphrase, and the two used to share one message. Telling someone
 *  their passphrase was wrong when it was right sends them off retyping a
 *  correct one, so the validator's own message wins where there is one.
 *
 *  Split out from the click handler because that handler builds a file input
 *  and calls `prompt()`, which makes the branch effectively untestable in
 *  place - and this is the branch worth testing. */
export function importErrorMessage(err: unknown): string {
  return err instanceof InvalidMapError ? err.message : 'Import failed - wrong passphrase?'
}

/** Keep a hostile key from filling the error toast with its own content. */
function preview(key: string): string {
  const clean = key.replace(/\s+/g, ' ').trim()
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean || '(empty)'
}
