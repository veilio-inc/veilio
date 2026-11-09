import { describe, it, expect } from 'vitest'
import { printable } from '../src/reservations.js'

// The server's words, before a terminal shows them (spec 066 code review;
// spec 080 review: a line or paragraph separator starts a new line too).
describe('printable', () => {
  it.each([
    ['ESC', '\u001b[2J'],
    ['BEL', '\u0007'],
    ['newline', '\n'],
    ['DEL', '\u007f'],
    ['C1 CSI', '\u009b'],
    ['bidi override', '‮'],
    ['bidi isolate', '⁦'],
    ['zero-width space', '​'],
    ['right-to-left mark', '‏'],
    ['line separator', ' '],
    ['paragraph separator', ' '],
  ])('replaces a %s', (_, ch) => {
    expect(printable(`a${ch}b`)).toBe(`a?${ch.slice(1)}b`)
  })

  it('keeps letters, Polish, German and Greek included', () => {
    expect(printable('Zespół Straße Ομάδα 1.0')).toBe('Zespół Straße Ομάδα 1.0')
  })
})
