import { describe, expect, it } from 'vitest'

// A map grown any way but grow() throws here (review of 5347c7c).
;(globalThis as { __veilioStrictMaps?: boolean }).__veilioStrictMaps = true
import { join, resolve } from 'node:path'

// Property: whatever mix of credentials, regulated numbers, map placeholders
// and ordinary names a text holds, in whatever order, masking it removes every
// value the scanner flags on the raw text, and leaves ordinary names and the
// map's placeholders as they were. A whole class of ordering and overlap bugs
// fails here at once (review of da4ff84). Seeded, so a failure reproduces.

// GUARD_ROOT runs the same property against another checkout of the plugin.
const PLUGIN = process.env.GUARD_ROOT ?? resolve(import.meta.dirname, '../../plugins/veilio-guard')
const { applyMap, Destroyed, survivingSecrets } = await import(join(PLUGIN, 'lib/scrub.ts'))
const { generate } = await import(
  resolve(import.meta.dirname, '../../plugins/veilio-guard/tests/fixtures/generate.ts')
)

describe('masking, as a property', () => {
  it('removes every flagged value and keeps names and placeholders, over 1,500 random texts', () => {
    const failures: string[] = []
    for (let seed = 1; seed <= 1_500; seed++) {
      const c = generate(seed)
      const known = new Destroyed()
      const out: string = applyMap(c.text, c.map, undefined, { known })
      for (const v of c.forbidden)
        if (out.includes(v)) failures.push(`seed ${seed}: ${JSON.stringify(v)} survived`)
      for (const name of c.names)
        if (!out.includes(name)) failures.push(`seed ${seed}: name ${name} lost`)
      for (const p of c.placeholders)
        if (!out.includes(p)) failures.push(`seed ${seed}: placeholder ${p} lost`)
      if (survivingSecrets(out, c.map).length > 0)
        failures.push(`seed ${seed}: the last scan objects`)
      if (failures.length > 5) break
    }
    expect(failures).toEqual([])
  })
})
