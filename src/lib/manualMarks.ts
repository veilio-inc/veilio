import { anonymize, measureCommentExposure, STRIPPABLE_TYPES } from '@veilio-inc/engine'
import type { CommentExposure, StrippedItemType, SymbolMap } from '@veilio-inc/engine'

export interface MarkState {
  output: string
  map: SymbolMap
  /** How much comment prose the output still carries unmasked.
   *
   *  Carried alongside rather than recomputed by the caller: marking a name in
   *  a comment is the gesture the notice asks for, so the figure has to move
   *  with it — and `anonymize` already returns the answer for exactly this
   *  text. Measuring it again would run a second language detection whose
   *  result could disagree with the one that produced the output. */
  comments: CommentExposure
}

/** Mask a span the engine left alone.
 *
 *  Operates on the anonymized OUTPUT rather than the original source, which the
 *  page no longer holds once it has anonymized. Safe because anonymize is
 *  idempotent over its own output: placeholders already present are preserved
 *  rather than re-masked, so only the newly marked term changes.
 *
 *  Throws `ManualMaskError` from the engine when the term scans as a credential.
 *  Callers are expected to surface that rather than swallow it — the whole point
 *  is that masking a live key would write it to a map that gets exported. */
export function maskSelection(state: MarkState, term: string): MarkState {
  const trimmed = term.trim()
  if (!trimmed) return state

  const result = anonymize(state.output, { existingMap: state.map, manual: [trimmed] })
  return { output: result.anonymized, map: result.map, comments: result.comments }
}

/** Undo a manual mark: put the text back and drop the entry.
 *
 *  Substitutes directly rather than re-running anonymize, so unmarking is exact
 *  and cannot disturb any other placeholder.
 *
 *  The trailing-digit guard is the subtle part: a plain replace of `__MANUAL__1`
 *  also rewrites the prefix of `__MANUAL__10`, silently corrupting an unrelated
 *  mark and leaving a stray digit in the code. */
export function unmaskTerm(state: MarkState, placeholder: string): MarkState {
  const term = state.map[placeholder]
  if (term === undefined) return state

  const map = { ...state.map }
  delete map[placeholder]

  const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`${escaped}(?!\\d)`, 'g')
  // Unmasking puts prose back into the text, so the exposure moves the other
  // way. This path deliberately does not re-anonymize, so it is the one place
  // that has to measure for itself.
  const output = state.output.replace(pattern, term)
  return { output, map, comments: measureCommentExposure(output) }
}

/** Shorten a term for a toast without hiding what was acted on. */
export function previewTerm(term: string, max = 30): string {
  return term.length > max ? `${term.slice(0, max)}…` : term
}

/** Which AI artifacts to remove on restore.
 *
 *  `'all'` is the engine default and includes JSDoc, which is right when a model
 *  volunteered documentation as noise and wrong when it was asked to write it —
 *  deleting requested work. Keeping docs means every other category still goes.
 */
export function stripOption(keepDocs: boolean): StrippedItemType[] | 'all' {
  return keepDocs ? STRIPPABLE_TYPES.filter((t) => t !== 'jsdoc') : 'all'
}
