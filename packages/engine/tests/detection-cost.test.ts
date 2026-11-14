import { describe, it, expect } from 'vitest'
import { anonymize, guessLanguage } from '../src/index.js'

// Spec 094: detecting the language costs time in proportion to the text. A
// file of blank lines used to cost the square of its length.
// Timing: rerun this file alone before believing a failure.

describe('language detection is linear on blank lines', () => {
  const time = (run: () => unknown): number => {
    let best = Infinity
    for (let i = 0; i < 5; i++) {
      const t = performance.now()
      run()
      best = Math.min(best, performance.now() - t)
    }
    return best
  }

  it.each([
    ['line feeds', '\n'],
    ['a space and a line feed', ' \n'],
    ['CRLF', '\r\n'],
    ['tabs and line feeds', '\t\t\n'],
  ])(
    '40,000 lines of %s are masked in under a second, and detection grows with the text, not with its square',
    (_, line) => {
      const small = line.repeat(40_000)
      expect(time(() => anonymize(small))).toBeLessThan(1000)
      // The detection itself: the rest of masking is timed by its own tests.
      // The detection itself, on more text so the times are above the clock's
      // noise. Eight times the text: linear is 8x, quadratic 64x.
      const [a, b] = [2, 16].map((times) => time(() => guessLanguage(small.repeat(times))))
      expect(b! / Math.max(a!, 4)).toBeLessThan(24)
    },
    120_000
  )

  it('still finds C by its includes and defines, after blank and indented lines', () => {
    const code =
      '\n\n  \n#include <stdio.h>\n\n\t#define RETRIES 3\n  #pragma once\n#ifndef LEDGER_H\n'
    expect(guessLanguage(code)).toMatchObject({ language: 'c', fallback: false })
  })
})
