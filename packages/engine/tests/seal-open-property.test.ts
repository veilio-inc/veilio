import { describe, it, expect } from 'vitest'
import { webcrypto } from 'node:crypto'
import {
  anonymize,
  decryptMapFromVault,
  decryptTeamMap,
  encryptMapForVault,
  encryptTeamMap,
  restore,
  sealableMap,
  type CryptoKeyLike,
} from '../src/index.js'
import { baselineRows } from './fixtures/baseline-corpus.js'
import { SYNTAXES, VALUES } from './fixtures/syntax-corpus.js'
import { HELD, ROWS as MARKS } from './fixtures/manual-marks.js'

// For every row of the baseline corpus: the map `anonymize` returns is one
// the sealing check accepts, it seals and opens equal, and the opened map
// restores what the returned one restores. A row whose map is over a limit
// would be listed here by name, with the refusal; none is. (The passphrase
// file runs the same check; its key derivation is too slow for a thousand
// maps, and envelope.test.ts holds its round trip.)
const OVER_A_LIMIT: Record<string, string> = {}

const rows = baselineRows({ syntaxes: SYNTAXES, values: VALUES, marks: MARKS, held: HELD })

describe('every map the corpus makes seals, opens equal and restores', () => {
  it('lists only rows of the corpus', () => {
    const names = new Set(rows.map((r) => r.name))
    expect(Object.keys(OVER_A_LIMIT).filter((name) => !names.has(name))).toEqual([])
  })

  it('holds for every row and option set', async () => {
    const key = (await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ])) as CryptoKeyLike
    const refused: Record<string, string> = {}
    let sealed = 0
    for (const { name, code, options } of rows) {
      for (const given of options) {
        const { anonymized, map } = anonymize(code, given)
        try {
          sealableMap(map)
        } catch (err) {
          refused[name] = (err as Error).message
          continue
        }
        const expected = restore(anonymized, map).restored
        // The input itself, where nothing is redacted one-way. (The rows of
        // manual-marks.ts have their own record of what a mark gives back.)
        if (!name.startsWith('mark: ') && !`${anonymized}${expected}`.includes('__REDACTED_'))
          expect(expected, name).toBe(code)
        for (const opened of [
          await decryptMapFromVault(key, await encryptMapForVault(key, map)),
          await decryptTeamMap(key, await encryptTeamMap(key, map)),
        ]) {
          expect(opened, name).toEqual(map)
          expect(restore(anonymized, opened).restored, name).toBe(expected)
        }
        sealed++
      }
    }
    expect(refused).toEqual(OVER_A_LIMIT)
    expect(sealed).toBeGreaterThan(1000)
  }, 120_000)
})
