import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { VERSION } from '../src/version.js'
import { FakeCloud, signIn } from './helpers/fake-cloud.js'

/**
 * Which program sent a request (tracker d12): a burst of ~300 requests in two
 * minutes hit the rate limit and Cloud could not tell what had sent them.
 * Every request now says, as a self-report the server logs and never uses for
 * access: `X-Veilio-Client: cli` and `User-Agent: veilio-cli/<version>` from
 * the CLI. The MCP server's own label is tested in its package.
 */

let home: string
let cloud: FakeCloud
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-identity-'))
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
})

describe('the CLI names itself on every request', () => {
  it('X-Veilio-Client: cli and User-Agent: veilio-cli/<version>', async () => {
    signIn(home)
    const code = await main(['maps', 'list'], {
      cwd: home,
      home,
      stdin: async () => '',
      stdout: () => undefined,
      stderr: () => undefined,
    })
    expect(code).toBe(0)
    expect(cloud.requests.length).toBeGreaterThan(0)
    for (const r of cloud.requests) {
      expect(r.headers['x-veilio-client']).toBe('cli')
      expect(r.headers['user-agent']).toBe(`veilio-cli/${VERSION}`)
    }
  })
})
