// What every test of a credential rule asserts: the value is replaced by a
// one-way token, no part of it is in the output or the map, and the text
// around it restores exactly.
import { expect } from 'vitest'
import { anonymize, restore } from '../../src/index.js'
import type { AnonymizeOptions, SymbolMap } from '../../src/types.js'

const TOKEN = /__REDACTED_[A-Z_]+_\d+__/g

/** Every run of six characters of `secret` (the whole of a shorter one). */
export const slices = (secret: string): string[] =>
  secret.length <= 6
    ? [secret]
    : Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6))

/** Whether any six characters of `secret` are readable in `text`. */
export const holds = (text: string, secret: string): boolean =>
  slices(secret).some((s) => text.includes(s))

/**
 * Masks `code` and checks that each of `secrets` is redacted one-way: a
 * redaction token in the output, no six characters of it in the output or in
 * a map value, and the rest of the text restored exactly. `also` lists other
 * words the same redaction takes with it (a header's scheme word).
 */
export function expectRedacted(
  code: string,
  options: AnonymizeOptions,
  secrets: readonly string[],
  also: readonly string[] = []
): { anonymized: string; map: SymbolMap } {
  const { anonymized, map } = anonymize(code, options)
  expect(anonymized).toMatch(TOKEN)
  const held = Object.values(map).join('\n')
  for (const secret of secrets) {
    expect(holds(anonymized, secret), 'readable in the output').toBe(false)
    expect(holds(held, secret), 'held in the map').toBe(false)
  }
  let rest = code
  for (const gone of [...secrets, ...also]) rest = rest.split(gone).join('')
  expect(restore(anonymized, map).restored.replace(TOKEN, '')).toBe(rest)
  return { anonymized, map }
}

/** Masks `code` and checks that nothing in it is redacted one-way and that it
 *  restores exactly. */
export function expectKept(code: string, options: AnonymizeOptions): void {
  const { anonymized, map } = anonymize(code, options)
  expect(anonymized).not.toMatch(TOKEN)
  expect(restore(anonymized, map).restored).toBe(code)
}
