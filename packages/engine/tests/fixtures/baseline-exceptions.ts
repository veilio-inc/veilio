// The rows of baseline-corpus.ts whose answer may differ from the published
// 1.19.1 (baseline-1.19.1.json), one entry per row and option set, each with
// the fix that changes it. Written row by row, never as a pattern: a
// difference nobody listed must fail the test.
import type { AnonymizeOptions } from '../../src/types.js'

export const FINDINGS = ['C1', 'C2', 'M3', 'H1', 'M4', 'L4'] as const

export interface BaselineException {
  row: string
  options: AnonymizeOptions
  finding: (typeof FINDINGS)[number]
  why: string
}

export const EXCEPTIONS: BaselineException[] = []
