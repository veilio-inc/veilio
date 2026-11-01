import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listTools } from '../src/tools.js'
import { handleMessage } from '../src/server.js'

// Security audit 2026-11-01 (MEDIUM): restore_text hands the calling model
// every real name, and its description invited the call. In a client with no
// guard to re-mask the result, one call undoes the masking. Founder 1 Nov:
// warn plainly, no change in behaviour.
const WARNING = /real (names|identifiers)[^.]*(your|the model'?s) context/i

describe('restore_text says what its result does', () => {
  it('in its tool description', () => {
    const home = mkdtempSync(join(tmpdir(), 'veilio-warn-'))
    const t = listTools({ cwd: '/', mapPath: null, home }).find((x) => x.name === 'restore_text')!
    expect(t.description).toMatch(WARNING)
    expect(t.description).not.toMatch(/Use this on a reply that came back/)
  })
  it('in the server instructions', () => {
    const reply = handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { cwd: '/', mapPath: null }
    ) as {
      result: { instructions: string }
    }
    expect(reply.result.instructions).toMatch(/restore_text/)
    expect(reply.result.instructions).toMatch(WARNING)
  })
})
