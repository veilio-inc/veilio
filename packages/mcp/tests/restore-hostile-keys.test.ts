import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveMapPath } from '@veilio-inc/cli/store'
import { ALIASES_FILE } from '@veilio-inc/cli/reservations'
import { callTool } from '../src/tools.js'

// Security audit: restore_text built a RegExp from every key map.json and
// aliases.json disagree on, unescaped - `(x+x+)+y` froze it, `(` threw.
//
// 2026-11-16: the expectation for map.json changed. A map file holding a key
// that is not a placeholder is refused, naming the key, by every tool that
// reads it - it is no longer read with the key dropped, which left masking to
// use the file as it was. aliases.json keeps drop-and-count.
function ctxWith(map: Record<string, string>, aliases: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-hk-'))
  const mapPath = resolveMapPath(null, cwd)
  mkdirSync(dirname(mapPath), { recursive: true })
  writeFileSync(mapPath, JSON.stringify({ map }))
  writeFileSync(join(dirname(mapPath), ALIASES_FILE), JSON.stringify({ version: 1, aliases }))
  return { cwd, mapPath: null, restoreText: true }
}

const refusal = (cwd: string, key: string): string =>
  `map file at ${resolveMapPath(null, cwd)} holds a key that is not a placeholder ("${key}"), so the file is not used. Remove that entry from the file.`

describe('a map file with a key that is not a placeholder is not used', () => {
  it.each([['(x+x+)+y'], ['('], ['fetch']])('%s: restore_text refuses the file', (key) => {
    const ctx = ctxWith({ [key]: 'a', __VAR__1: 'amount' }, {})
    const started = Date.now()
    const r = callTool('restore_text', { text: `${'x'.repeat(29)} fetch __VAR__1` }, ctx)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(r.isError).toBe(true)
    expect(r.text).toContain(refusal(ctx.cwd, key))
    expect(r.text).not.toContain('amount')
  })

  it('anonymize_text refuses it too, and the file is left as it was', () => {
    const ctx = ctxWith({ fetch: 'send', __VAR__1: 'amount' }, {})
    const before = readFileSync(resolveMapPath(null, ctx.cwd), 'utf8')
    const r = callTool('anonymize_text', { text: 'const settleLedger = 1' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.text).toContain(refusal(ctx.cwd, 'fetch'))
    expect(r.text).not.toContain('__VAR__')
    expect(readFileSync(resolveMapPath(null, ctx.cwd), 'utf8')).toBe(before)
  })
})

describe('aliases.json with keys that are not placeholders', () => {
  it('they are dropped and counted, and restore_text goes on', () => {
    const ctx = ctxWith({ __VAR__1: 'amount' }, { '(x+x+)+y': 'b', '(': 'c' })
    const started = Date.now()
    const r = callTool('restore_text', { text: `${'x'.repeat(29)} __VAR__1` }, ctx)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(r.isError ?? false, r.text).toBe(false)
    expect(r.text).toContain(`${'x'.repeat(29)} amount`)
    expect(r.text).toContain('ignored 2 entries in aliases.json whose key is not a placeholder.')
  })
})
