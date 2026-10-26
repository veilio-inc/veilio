import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  REFUSAL_CODES,
  WORDING,
  refuse,
  refusalFromCloudError,
  renderRefusal,
  type RefusalCode,
} from '../../src/client/wording.js'
import { listCloudMaps } from '../../src/client/maps.js'
import { CloudError } from '../../src/cloud.js'
import { writeCredential } from '../../src/credential.js'

/**
 * T006 (spec 052): the shared client's contract with its two renderers.
 *
 * Every operation answers `{ ok: true, value }` or `{ ok: false, refusal }`,
 * and every refusal comes out of ONE table, so the CLI and the MCP server say
 * the same thing for the same reason (FR-019). The table is checked as a table:
 * one entry per code, each naming its reason and what resolves it. A refusal
 * that says only what went wrong leaves the person exactly where they were.
 */

/** What "names what resolves it" means, mechanically: a command to run, or an
 *  instruction that starts with something a person can do. */
const ACTIONABLE =
  /`[^`]+`|\b(Run|Re-run|Ask|Pass|Open|Create|Choose|Check|Split|Remove|Start|Sign|Contact|Change|Push|Pull|Export|Share|Call|Join|Wait|Use)\b/

const SAMPLE = {
  id: 'map-1',
  name: 'billing',
  count: 3,
  detail: 'something went wrong',
  path: '/p/.veilio/map.json',
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-02T00:00:00.000Z',
  list: '__CLS__1, __FN__2',
  project: 'payments',
}

describe('the wording table (FR-019)', () => {
  it('has exactly one entry per refusal code', () => {
    expect(Object.keys(WORDING).sort()).toEqual([...REFUSAL_CODES].sort())
    expect(new Set(REFUSAL_CODES).size).toBe(REFUSAL_CODES.length)
  })

  it.each([...REFUSAL_CODES])('%s names its reason and what resolves it', (code) => {
    const { message, resolve } = WORDING[code as RefusalCode](SAMPLE)
    expect(message.trim().length, 'no reason given').toBeGreaterThan(10)
    expect(resolve.trim().length, 'no resolution given').toBeGreaterThan(5)
    expect(resolve, 'the resolution names nothing anybody can do').toMatch(ACTIONABLE)
    // A refusal is a sentence a person reads; a stray template hole is not.
    expect(`${message} ${resolve}`).not.toMatch(/undefined|\[object|NaN/)
  })

  it('never carries the product prefix: each renderer adds its own', () => {
    for (const code of REFUSAL_CODES) {
      const { message } = WORDING[code](SAMPLE)
      expect(message).not.toMatch(/^veilio:/i)
    }
  })
})

describe('the outcome shape', () => {
  it('refuse() answers { ok: false, refusal: { code, message, resolve } }', () => {
    const r = refuse('not_signed_in')
    expect(r.ok).toBe(false)
    expect(r.refusal).toEqual({
      code: 'not_signed_in',
      message: 'not signed in.',
      resolve: 'Run `veilio login` first.',
    })
  })

  it('renders for a terminal as one line, prefixed, with the detail lines after', () => {
    const r = refuse('clash', { count: 1, list: '__CLS__1' }, [
      '__CLS__1: this map says A, the team says B',
    ])
    const text = renderRefusal(r.refusal)
    expect(text.startsWith('veilio: 1 placeholder in this map')).toBe(true)
    expect(text).toContain('Re-run `veilio scrub --team`')
    expect(text.endsWith('  __CLS__1: this map says A, the team says B\n')).toBe(true)
  })

  it('the sign-in sentence is byte-identical to the one the CLI has always printed', () => {
    expect(renderRefusal(refuse('not_signed_in').refusal)).toBe(
      'veilio: not signed in. Run `veilio login` first.\n'
    )
  })
})

describe('a failed request becomes a refusal with the right remedy', () => {
  it.each([
    [new CloudError('unauthenticated', 'x', 401), 'session_rejected'],
    [new CloudError('unentitled', 'no terminal on this plan', 402), 'unentitled'],
    [new CloudError('suspended', 'this account is suspended', 403), 'suspended'],
    [new CloudError('forbidden', 'Team owners only', 403), 'forbidden'],
    [new CloudError('unreachable', 'could not reach x', undefined), 'unreachable'],
    [new CloudError('server', 'boom', 500), 'server'],
    [new CloudError('server', 'Project not found', 404), 'project_gone'],
  ] as const)('%s -> %s', (err, code) => {
    expect(refusalFromCloudError(err, { project: 'p-1' }).code).toBe(code)
  })

  it('an abuse ceiling never says "upgrade"', () => {
    const r = refusalFromCloudError(new CloudError('forbidden', 'Map limit reached', 403))
    expect(r.code).toBe('abuse_limit')
    expect(`${r.message} ${r.resolve}`).toMatch(/same on every paid plan/)
  })

  it('anything that is not a CloudError is reported as itself, never swallowed', () => {
    const r = refusalFromCloudError(new Error('disk full'))
    expect(r.code).toBe('server')
    expect(r.message).toContain('disk full')
  })
})

describe('a client operation, against a fake server', () => {
  let home: string
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'veilio-client-home-'))
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(home, { recursive: true, force: true })
  })

  it('signed out: the sign-in refusal, and no request at all', async () => {
    const r = await listCloudMaps({ home })
    expect(r).toEqual(refuse('not_signed_in'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('signed in: { ok: true, value } with whose each map is', async () => {
    writeCredential({ token: 't', account: 'a@b.test', instance: 'https://veilio.test' }, home)
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          personalMaps: [
            {
              id: 'm1',
              name: 'mine',
              scope: 'personal',
              identifier_count: 2,
              created_at: 'c',
              updated_at: 'u',
            },
          ],
          teamMaps: [
            {
              id: 'm2',
              name: 'theirs',
              scope: 'team',
              identifier_count: null,
              created_at: 'c',
              updated_at: 'u',
            },
          ],
          team: { id: 't1' },
          plan: 'team',
        }),
        { status: 200 }
      )
    )
    const r = await listCloudMaps({ home })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.maps.map((m) => [m.id, m.scope, m.mine])).toEqual([
      ['m1', 'personal', true],
      ['m2', 'team', false],
    ])
  })

  it('a failed request is a refusal, never a throw', async () => {
    writeCredential({ token: 't', account: 'a@b.test', instance: 'https://veilio.test' }, home)
    fetchMock.mockRejectedValue(new TypeError('getaddrinfo ENOTFOUND'))
    const r = await listCloudMaps({ home })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.refusal.code).toBe('unreachable')
    expect(r.refusal.message).toContain('ENOTFOUND')
  })
})
