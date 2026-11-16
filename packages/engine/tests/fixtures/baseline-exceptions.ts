// The rows of baseline-corpus.ts whose answer may differ from the published
// 1.19.3 (baseline-1.19.3.json), one entry per row and option set, each with
// the fix that changes it. Written row by row, never as a pattern: a
// difference nobody listed must fail the test.
import type { AnonymizeOptions } from '../../src/types.js'

export const REASONS = [
  'provider-format',
  'credential-context',
  'credential-name-language',
  'multi-line-credential',
  'login-command',
] as const

export interface BaselineException {
  row: string
  options: AnonymizeOptions
  reason: (typeof REASONS)[number]
  why: string
}

export const EXCEPTIONS: BaselineException[] = []

/** Tracked files of this repository that hold more redaction tokens than the
 *  published 1.19.3 left in them (baseline-1.19.3.repo.json), by path: how
 *  many more, and the fix that adds them. */
export const REPOSITORY_EXCEPTIONS: Record<
  string,
  { more: number; reason: (typeof REASONS)[number] }
> = {}
