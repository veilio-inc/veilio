import { describe, it, expect } from 'vitest'
import { restore } from '../src/engine.js'
import { locallyNumberedNote, restoreLayers } from '../src/restoreLayers.js'
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

// Staging walk, 2026-10-01: a personal map PULLED from Cloud was told it had
// "numbered it locally". The note states what is known - the project's map and
// the team's maps disagree - and offers the causes only as examples.
describe('locallyNumberedNote', () => {
  it('states the disagreement, not a cause it cannot know', () => {
    const note = locallyNumberedNote(['__VAR__1'])
    expect(note).toMatch(/^left as is: __VAR__1\./)
    expect(note).toMatch(
      /this project's map and the team's maps give this placeholder different identifiers/i
    )
    expect(note).toMatch(/for example/i)
    expect(note).toMatch(/personal map/)
    expect(note).not.toMatch(/numbered it locally/)
    expect(note).toMatch(/restoring would be a guess/)
  })

  it('in the plural for several', () => {
    expect(locallyNumberedNote(['__VAR__1', '__FN__2'])).toMatch(
      /__VAR__1, __FN__2\. .*these placeholders different identifiers/i
    )
  })
})
