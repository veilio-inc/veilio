import { describe, it, expect } from 'vitest'
import { AI_PREAMBLE, withAiPreamble } from '../src/engine.js'

// A short note pasted ABOVE the masked code so the downstream AI knows the
// placeholders are an intentional privacy measure, not obfuscation to refuse.

describe('AI_PREAMBLE', () => {
  it('is a non-empty string that explains the placeholders', () => {
    expect(typeof AI_PREAMBLE).toBe('string')
    expect(AI_PREAMBLE.length).toBeGreaterThan(0)
    expect(AI_PREAMBLE.toLowerCase()).toContain('placeholder')
  })
})

describe('withAiPreamble', () => {
  it('prepends the preamble and keeps the code intact', () => {
    const code = 'function __P1__() { return __P2__ }'
    const out = withAiPreamble(code)
    expect(out.startsWith(AI_PREAMBLE)).toBe(true)
    expect(out).toContain(code)
  })

  it('leaves a placeholder in the code unchanged', () => {
    expect(withAiPreamble('const __P3__ = 1')).toContain('__P3__')
  })
})
