import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { MAP_LIMITS } from '@veilio-inc/engine'

// The limits of a map are published in three documents. Each number written
// there is the engine's constant, so a change to one is a change to both.
// Paths resolve from the vitest root.
const counted = (n: number): string => n.toLocaleString('en-US')
const read = (path: string): string => readFileSync(path, 'utf8')

describe('the published map limits are the engine’s', () => {
  it('the engine README states all three, and names the constant', () => {
    expect(read('packages/engine/README.md')).toContain(
      `A map holds up to ${counted(MAP_LIMITS.entries)} entries, each value up to ${counted(MAP_LIMITS.valueLength)} characters, and up to ${counted(MAP_LIMITS.sealedLength)} characters once sealed (\`MAP_LIMITS\`).`
    )
  })

  it('the CLI README states the value limit', () => {
    expect(read('packages/cli/README.md')).toContain(
      `A value longer than ${counted(MAP_LIMITS.valueLength)} characters stays masked, but its map is not saved and not pushed`
    )
  })

  it('SECURITY.md states what an older passphrase file may hold', () => {
    expect(read('SECURITY.md')).toContain(
      `with more than ${counted(MAP_LIMITS.entries)} entries, or a value longer than ${counted(MAP_LIMITS.valueLength)} characters, cannot be opened`
    )
  })
})
