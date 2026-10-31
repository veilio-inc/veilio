import { describe, expect, it } from 'vitest'
import { applyMap, scrubSource, survivingSecrets } from '../../plugins/veilio-guard/lib/scrub.ts'
import type { FileKind } from '../../plugins/veilio-guard/vendor/engine/index.js'

// Security audit (spec 064 regression): a dictionary-word password is an
// ordinary word, which 064 shows as written - but as the value of a
// credential-named key it is a password, and it never reaches the model.
const FILES: [string, string, string, FileKind?][] = [
  ['auto', 'spring:\n  datasource:\n    password: sunshine\n', 'sunshine', 'yaml'],
  ['auto', 'password: sunshine\n', 'sunshine'],
  ['typescript', 'export const db = { user: "ledger", password: "dragon" }\n', 'dragon'],
  ['python', 'DATABASES = {"default": {"PASSWORD": "monkey"}}\n', 'monkey'],
  ['python', 'SECRET_KEY = "phoenix"\n', 'phoenix'],
  ['auto', 'DB_PASSWORD=sunshine\n', 'sunshine'],
  ['auto', 'DB_PASSWORD=sunshine\n', 'sunshine', 'dotenv'],
  ['auto', 'DB_PASSWORD: sunshine\n', 'sunshine', 'yaml'],
  ['auto', 'export DB_PASSWORD=sunshine\n', 'sunshine', 'shell'],
]

describe('scrubSource: a file Claude reads', () => {
  it.each(FILES)('%s %j does not show %s', (language, text, word, fileKind) => {
    const r = scrubSource(text, {}, language as 'auto', new Set(), fileKind)
    expect(r.text).not.toMatch(new RegExp(`\\b${word}\\b`))
    expect(survivingSecrets(r.text, r.additions)).toEqual([])
  })

  it('the control: an ordinary word that is not a credential value stays readable', () => {
    const r = scrubSource('const password_hint = "sunshine is a word"\n', {}, 'typescript')
    expect(r.text).toContain('sunshine is a word')
  })
})

describe('applyMap: command output, with the word in the map', () => {
  const MAP = { __VAR__1: 'sunshine', __VAR__2: 'monkey' }
  it.each([
    ['DB_PASSWORD=sunshine', 'sunshine'],
    ['password: sunshine', 'sunshine'],
    ['DATABASES = {"default": {"PASSWORD": "monkey"}}', 'monkey'],
  ])('%j does not show %s', (text, word) => {
    expect(applyMap(text, MAP)).not.toContain(word)
  })

  it('the control: the same word in prose stays readable', () => {
    expect(applyMap('a sunshine day; password_hint = "sunshine is a word"', MAP)).toBe(
      'a sunshine day; password_hint = "sunshine is a word"'
    )
  })
})
