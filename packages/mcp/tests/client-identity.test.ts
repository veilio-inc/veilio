import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { callToolAsync } from '../src/tools.js'
import { primeNamespace, resetNamespaceCache } from '../src/namespace.js'
import { FakeCloud, signIn } from '../../cli/tests/helpers/fake-cloud.js'

/**
 * The MCP server names itself, not the CLI whose client it uses (tracker d12):
 * `X-Veilio-Client: mcp` and `User-Agent: veilio-mcp/<its own version>`, on a
 * tool call and on the team-namespace read alike. A self-report: the server
 * logs it, and never uses it for access.
 */

const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

let home: string
let cwd: string
let cloud: FakeCloud
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-mcp-identity-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-identity-work-'))
  mkdirSync(join(cwd, '.git'))
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
  resetNamespaceCache()
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetNamespaceCache()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

describe('the MCP server names itself on every request', () => {
  it('a tool call and the namespace read: X-Veilio-Client: mcp, User-Agent: veilio-mcp/<version>', async () => {
    signIn(home, { team: true })
    const r = await callToolAsync('maps_list', {}, { cwd, mapPath: null, home })
    expect(r.isError ?? false, r.text).toBe(false)
    await primeNamespace(home)
    expect(cloud.requests.length).toBeGreaterThan(1)
    for (const req of cloud.requests) {
      expect(req.headers['x-veilio-client'], req.path).toBe('mcp')
      expect(req.headers['user-agent'], req.path).toBe(`veilio-mcp/${VERSION}`)
    }
  })
})
