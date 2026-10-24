import { describe, expect, it } from 'vitest'
import { maskShaped, NO_CONTEXT } from '../../plugins/veilio-guard/lib/scrub.ts'
import { restore } from '../../plugins/veilio-guard/vendor/engine/index.js'

// Spec 050 R1: a name shaped like an identifier that is still in a result after
// the map is applied - a file the index has not reached, a generated file - is
// masked and added, so it can be restored. Prose and the runner's own words
// stay as written.

describe('maskShaped', () => {
  it('masks camelCase, snake_case and PascalCase names, and adds them to the map', () => {
    const { text, additions } = maskShaped(
      'TypeError in luhnValid at team_layers via BatchReconciler',
      {},
      NO_CONTEXT
    )
    expect(text).not.toMatch(/luhnValid|team_layers|BatchReconciler/)
    expect(Object.values(additions).sort()).toEqual(['BatchReconciler', 'luhnValid', 'team_layers'])
    expect(restore(text, additions, { strip: 'none' }).restored).toBe(
      'TypeError in luhnValid at team_layers via BatchReconciler'
    )
  })

  it('reuses a placeholder the map already has', () => {
    const { text, additions } = maskShaped(
      'call luhnValid twice: luhnValid',
      { __FN__7: 'luhnValid' },
      NO_CONTEXT
    )
    expect(text).toBe('call __FN__7 twice: __FN__7')
    expect(additions).toEqual({})
  })

  it('numbers new placeholders after the ones the map holds', () => {
    const { additions } = maskShaped('reconcileBatch', { __VAR__4: 'settledTotal' }, NO_CONTEXT)
    const [placeholder] = Object.keys(additions)
    expect(placeholder).toMatch(/^__[A-Z]+__\d+$/)
    expect(placeholder).not.toBe('__VAR__4')
  })

  it('leaves English, ALL_CAPS constants, placeholders, error names and keywords as written', () => {
    const line =
      'expected false to be true: NODE_ENV __VAR__3 AssertionError TypeError instanceof JavaScript'
    expect(maskShaped(line, {}, { ...NO_CONTEXT, language: 'typescript' }).text).toBe(line)
  })

  it('leaves the names the project takes from outside', () => {
    const ctx = { ...NO_CONTEXT, external: new Set(['readFileSync']) }
    expect(maskShaped('readFileSync failed', {}, ctx).text).toBe('readFileSync failed')
  })

  it('does not run on what the user typed', () => {
    const ctx = { ...NO_CONTEXT, kind: 'prompt' as const }
    expect(maskShaped('fix luhnValid', {}, ctx).text).toBe('fix luhnValid')
  })
})
