import { describe, it, expect } from 'vitest'
import { restore } from '../src/engine.js'
import { restoreLayers } from '../src/restoreLayers.js'
import { RESTORE_CASES } from './fixtures/restore-cases.js'

// Spec 028: one restore rule for the web app, the CLI and the MCP server - the
// web app's rule, defined here once.
describe('restoreLayers', () => {
  it.each(RESTORE_CASES)('$name', (c) => {
    const layers = restoreLayers({ own: c.own, team: c.team })
    expect(restore(c.text, layers.map).restored).toBe(c.restored)
    expect(layers.disputedIn(c.text)).toEqual(c.disputed)
    expect(layers.locallyNumberedIn(c.text)).toEqual(c.locallyNumbered ?? [])
  })

  it('a placeholder inside a longer token is not a disputed one', () => {
    const layers = restoreLayers({
      own: {},
      team: { namespace: {}, aliases: {}, conflicts: { __FN__6: 2 } },
    })
    expect(layers.disputedIn('x__FN__6 __FN__61')).toEqual([])
  })
})
