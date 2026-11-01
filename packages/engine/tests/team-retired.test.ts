import { describe, expect, it } from 'vitest'
import { anonymize } from '../src/index.js'

// Code review of spec 066: a publish moves local entries out of the map into
// aliases.json. Numbered from the map alone, the local counter restarted at 1
// and minted a retired placeholder again for another name, while text the
// model still held meant the old one. `team.retired` floors the counters.
describe('anonymize team.retired', () => {
  const code = 'export const payoutCutoff = 5\n'
  const team = { blocks: {}, tag: 'K7Q2XA' }

  it('a retired local placeholder is never minted again', () => {
    const r = anonymize(code, {
      team: { ...team, retired: ['__LOCAL_K7Q2XA_VAR__1', '__LOCAL_K7Q2XA_VAR__2'] },
    })
    expect(Object.keys(r.map)).toEqual(['__LOCAL_K7Q2XA_VAR__3'])
  })

  it('a retired team number floors its block too', () => {
    const r = anonymize(code, {
      team: { blocks: { __VAR__: { start: 41, end: 540 } }, tag: 'K7Q2XA', retired: ['__VAR__41'] },
    })
    expect(Object.keys(r.map)).toEqual(['__VAR__42'])
  })

  it('digitless and malformed entries are ignored; retired is a known option key', () => {
    const r = anonymize(code, { team: { ...team, retired: ['__LOCAL_K7Q2XA_VAR__', 'x'] } })
    expect(Object.keys(r.map)).toEqual(['__LOCAL_K7Q2XA_VAR__1'])
  })
})
