// A project that has never used Veilio, and the results a cold session got
// from it, for spec 050 US1. The shapes are the ones Claude Code 2.1.288
// recorded (recorded.ts: the Bash and Grep `content` calls); the text is this
// project's, modelled on the 2026-10-24 benchmark's cold sessions, which fixed
// a bug by running the tests and searching, with no Read.
import { ROOT } from '../helpers.ts'

/** The names the project declares. None may reach the model. `settle` is a
 *  lowercase one-word name: no shape rule can tell it from English, so only
 *  the index protects it. */
export const DECLARED = ['luhnValid', 'BatchReconciler', 'reconcileBatch', 'settle', 'digitsOf']

export const COLD_FILES: Record<string, string> = {
  [`${ROOT}/src/secrets.ts`]: [
    'function digitsOf(value: string): string {',
    "  return value.replace(/\\D/g, '')",
    '}',
    '',
    'export function luhnValid(value: string): boolean {',
    '  const digits = digitsOf(value)',
    '  return digits.length >= 12',
    '}',
    '',
    'export function settle(batch: number[]): number {',
    '  return batch.length',
    '}',
    '',
  ].join('\n'),
  [`${ROOT}/src/batch.ts`]: [
    "import { settle } from './secrets.ts'",
    '',
    'export class BatchReconciler {',
    '  reconcileBatch(entries: number[]): number {',
    '    return settle(entries)',
    '  }',
    '}',
    '',
  ].join('\n'),
  [`${ROOT}/tests/secrets.test.ts`]: [
    "import { describe, expect, it } from 'vitest'",
    "import { luhnValid } from '../src/secrets.ts'",
    '',
    "describe('luhnValid', () => {",
    "  it('accepts a valid card', () => expect(luhnValid('4539 1488 0343 6467')).toBe(true))",
    '})',
    '',
  ].join('\n'),
}

const shell = (stdout: string) => ({
  ref: 1,
  result: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  text: stdout,
  isReadOnly: true,
})

/** `npx vitest run tests/secrets.test.ts`, failing: a stack trace and an
 *  assertion that name the project's functions. */
export const TEST_RUN = {
  e: {
    tool: 'Bash',
    tool_use_id: 'toolu_cold_1',
    command: 'npx vitest run tests/secrets.test.ts',
    description: 'Run the failing test',
  },
  r: shell(
    [
      ' FAIL  tests/secrets.test.ts > luhnValid > accepts a valid card',
      'AssertionError: expected false to be true',
      ' ❯ luhnValid src/secrets.ts:7:10',
      ' ❯ settle src/secrets.ts:11:3',
      ' ❯ BatchReconciler.reconcileBatch src/batch.ts:5:12',
      ' Test Files  1 failed (1)',
    ].join('\n')
  ),
}

/** Grep for the function, content mode. */
export const GREP = {
  e: {
    tool: 'Grep',
    tool_use_id: 'toolu_cold_2',
    pattern: 'luhnValid|reconcileBatch',
    output_mode: 'content',
  },
  r: {
    ref: 1,
    result: {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content: [
        'src/secrets.ts:5:export function luhnValid(value: string): boolean {',
        'src/batch.ts:4:  reconcileBatch(entries: number[]): number {',
      ].join('\n'),
      numLines: 2,
      totalLines: 2,
    },
    text: '',
    isReadOnly: true,
  },
}
