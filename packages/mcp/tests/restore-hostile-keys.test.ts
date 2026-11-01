import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveMapPath } from '@veilio-inc/cli/store'
import { ALIASES_FILE } from '@veilio-inc/cli/reservations'
import { callTool } from '../src/tools.js'

// Security audit: restore_text built a RegExp from every key map.json and
// aliases.json disagree on, unescaped - `(x+x+)+y` froze it, `(` threw.
function ctxWith(map: Record<string, string>, aliases: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-hk-'))
  const mapPath = resolveMapPath(null, cwd)
  mkdirSync(dirname(mapPath), { recursive: true })
  writeFileSync(mapPath, JSON.stringify({ map }))
  writeFileSync(join(dirname(mapPath), ALIASES_FILE), JSON.stringify({ version: 1, aliases }))
  return { cwd, mapPath: null }
}

describe('restore_text with keys that are not placeholders', () => {
  it('a backtracking key in both files: restore completes fast and still restores', () => {
    const ctx = ctxWith({ '(x+x+)+y': 'a', __VAR__1: 'amount' }, { '(x+x+)+y': 'b' })
    const started = Date.now()
    const r = callTool('restore_text', { text: `${'x'.repeat(29)} __VAR__1` }, ctx)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(r.isError ?? false, r.text).toBe(false)
    expect(r.text).toContain(`${'x'.repeat(29)} amount`)
    expect(r.text).toMatch(/ignored 2 entries/)
  })

  it('an invalid pattern as a key does not throw', () => {
    const ctx = ctxWith({ '(': 'a', __VAR__1: 'amount' }, { '(': 'c' })
    const r = callTool('restore_text', { text: 'x = __VAR__1' }, ctx)
    expect(r.isError ?? false, r.text).toBe(false)
    expect(r.text).toContain('x = amount')
  })
})
