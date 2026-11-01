import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadMap, resolveMapPath, saveMap } from '@veilio-inc/cli/store'
import { writeCredential } from '@veilio-inc/cli/credential'
import { callTool } from '../src/tools.js'
import { primeNamespace, resetNamespaceCache } from '../src/namespace.js'

/**
 * Code review of spec 066 (FR-001), the re-review's repro, for the MCP server:
 * signed in, no team unlock, no reserved.json, Cloud unreachable. New names
 * take a local family under a session tag, never the number above the map.
 */
beforeEach(() => {
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('fetch failed')
  })
  resetNamespaceCache()
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetNamespaceCache()
})

describe('signed in, team unknown, Cloud unreachable', () => {
  it('anonymize mints the local family', async () => {
    const home = mkdtempSync(join(tmpdir(), 'veilio-mcp-tu-home-'))
    writeCredential(
      { token: 't', account: 'member@example.test', instance: 'https://veilio.test' },
      home
    )
    await primeNamespace(home, { retryDelayMs: 0 })
    const cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-tu-'))
    saveMap(resolveMapPath(null, cwd), { __FN__3: 'settleInvoice' })
    const r = callTool(
      'anonymize_text',
      { text: 'function reverseEntry() {}' },
      { cwd, mapPath: null, home }
    )
    expect(r.text).not.toMatch(/__FN__4\b/)
    expect(Object.keys(loadMap(resolveMapPath(null, cwd))).filter((p) => p !== '__FN__3')).toEqual([
      expect.stringMatching(/^__LOCAL_[A-Z0-9]{6}_FN__1$/),
    ])
  })
})
