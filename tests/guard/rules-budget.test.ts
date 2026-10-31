import { describe, expect, it } from 'vitest'
import { scrubSource } from '../../plugins/veilio-guard/lib/scrub.ts'
import { bandText } from '../../plugins/veilio-guard/lib/ui.ts'
import type { Guard } from '../../plugins/veilio-guard/lib/guard.ts'
import type { CustomRule } from '../../plugins/veilio-guard/vendor/engine/index.js'

// Security audit: a Read whose custom rules ran out of matching budget is
// counted, and the band says custom rules stopped matching.
const HOSTILE = Array.from({ length: 20 }, (_, i): CustomRule => ({
  id: `h${i}`,
  scope: 'team',
  team_id: 't1',
  sort_order: i,
  name: `h${i}`,
  type: 'whitelist',
  pattern: `(\\w?\\w?){50}#|x${i}`,
  enabled: true,
}))
const SOURCE = Array.from({ length: 5000 }, (_, i) => `const identifier_name_${i}abc = 1`).join(
  '\n'
)

describe('the guard and the rule budget', () => {
  it('scrubSource says when custom rules stopped matching', () => {
    const r = scrubSource(SOURCE, {}, 'typescript', new Set(), undefined, undefined, HOSTILE)
    expect(r.rulesStopped).toBe(true)
    expect(r.text).not.toMatch(/identifier_name_/)
  })

  it('the band says so once a Read stopped them', () => {
    const g = {
      state: 'on',
      map: {},
      index: null,
      reserved: null,
      rules: {
        state: 'applied',
        rules: HOSTILE,
        skipped: { vaultLocked: 0, teamLocked: 0, unopenable: 0, refused: 0 },
      },
      counts: { withheld: 0, denied: 0, outsideReserved: 0, rulesStopped: 1 },
    } as unknown as Guard
    expect(bandText(g)).toContain('custom rules stopped matching: too much work')
  })
})
