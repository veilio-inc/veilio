import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveMapPath, saveMap } from '@veilio-inc/cli/store'
import { callToolAsync, type ToolContext } from '../src/tools.js'
import { contextFromArgv } from '../src/index.js'
import { FakeCloud, sealPersonal, signIn } from '../../cli/tests/helpers/fake-cloud.js'

/**
 * What stops an agent deleting or overwriting maps on its own (spec 052
 * FR-010, research §6, T022).
 *
 * Off by default. The PERSON turns it on, once, by starting the server with
 * VEILIO_MCP_DESTRUCTIVE=1 - a setting the agent cannot reach through a tool
 * call. Even then, a removal must repeat the map's exact name. Creating,
 * pulling, listing and updates that drop nothing always work.
 */

let home: string
let cwd: string
let cloud: FakeCloud
let ctx: ToolContext

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-gate-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-gate-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
  signIn(home, { pmk: true })
  ctx = { cwd, mapPath: null, home, destructive: false }
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const deletes = (): number => cloud.requests.filter((r) => r.method === 'DELETE').length
const patches = (): number => cloud.requests.filter((r) => r.method === 'PATCH').length

describe('the setting', () => {
  it('is off unless the server was started with VEILIO_MCP_DESTRUCTIVE=1', () => {
    expect(contextFromArgv([], {}).destructive).toBe(false)
    expect(contextFromArgv([], { VEILIO_MCP_DESTRUCTIVE: '0' }).destructive).toBe(false)
    expect(contextFromArgv([], { VEILIO_MCP_DESTRUCTIVE: 'true' }).destructive).toBe(false)
    expect(contextFromArgv([], { VEILIO_MCP_DESTRUCTIVE: '1' }).destructive).toBe(true)
  })

  it('no tool argument can turn it on', async () => {
    const row = cloud.add({ name: 'billing', map_data: await sealPersonal({ a: 'b' }, 'pmk') })
    const r = await callToolAsync(
      'maps_remove',
      { id: row.id, confirmName: 'billing', destructive: true, VEILIO_MCP_DESTRUCTIVE: '1' },
      ctx
    )
    expect(r.isError).toBe(true)
    expect(cloud.maps).toHaveLength(1)
  })
})

describe('maps_remove', () => {
  it('off: refused, saying how the person allows it, and nothing is sent', async () => {
    const row = cloud.add({ name: 'billing', map_data: await sealPersonal({ a: 'b' }, 'pmk') })
    const r = await callToolAsync('maps_remove', { id: row.id, confirmName: 'billing' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('VEILIO_MCP_DESTRUCTIVE=1')
    expect(cloud.requests).toHaveLength(0)
    expect(cloud.maps).toHaveLength(1)
  })

  it('on, with a name that is not the map’s exact name: refused, nothing removed', async () => {
    const row = cloud.add({ name: 'billing', map_data: await sealPersonal({ a: 'b' }, 'pmk') })
    for (const wrong of ['Billing', 'billing ', 'bill', '']) {
      const r = await callToolAsync(
        'maps_remove',
        { id: row.id, confirmName: wrong },
        { ...ctx, destructive: true }
      )
      expect(r.isError, wrong).toBe(true)
    }
    expect(deletes()).toBe(0)
    expect(cloud.maps).toHaveLength(1)
  })

  it('on, with no confirmName at all: refused', async () => {
    const row = cloud.add({ name: 'billing', map_data: await sealPersonal({ a: 'b' }, 'pmk') })
    const r = await callToolAsync('maps_remove', { id: row.id }, { ...ctx, destructive: true })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/confirmName/)
    expect(deletes()).toBe(0)
  })

  it('on, with the exact name: removed', async () => {
    const row = cloud.add({ name: 'billing', map_data: await sealPersonal({ a: 'b' }, 'pmk') })
    const r = await callToolAsync(
      'maps_remove',
      { id: row.id, confirmName: 'billing' },
      { ...ctx, destructive: true }
    )
    expect(r.isError ?? false, r.text).toBe(false)
    expect(cloud.maps).toHaveLength(0)
  })
})

describe('maps_update that would drop entries', () => {
  beforeEach(() => {
    saveMap(resolveMapPath(null, cwd), { __CLS__1: 'A' }, { force: true })
  })

  it('off, even with allowDrop: refused, saying how the person allows it', async () => {
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'A', __FN__2: 'b' }, 'pmk') })
    const r = await callToolAsync('maps_update', { id: row.id, allowDrop: true }, ctx)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('VEILIO_MCP_DESTRUCTIVE=1')
    expect(patches()).toBe(0)
  })

  it('off, without allowDrop: the drop refusal, with its count', async () => {
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'A', __FN__2: 'b' }, 'pmk') })
    const r = await callToolAsync('maps_update', { id: row.id }, ctx)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/would drop 1 entry/)
    expect(patches()).toBe(0)
  })

  it('on, with allowDrop: the entries go', async () => {
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'A', __FN__2: 'b' }, 'pmk') })
    const r = await callToolAsync(
      'maps_update',
      { id: row.id, allowDrop: true },
      { ...ctx, destructive: true }
    )
    expect(r.isError ?? false, r.text).toBe(false)
    expect(r.text).toMatch(/1 dropped as asked/)
  })

  it('on, without allowDrop: still refused - the setting allows, it does not ask', async () => {
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'A', __FN__2: 'b' }, 'pmk') })
    const r = await callToolAsync('maps_update', { id: row.id }, { ...ctx, destructive: true })
    expect(r.isError).toBe(true)
    expect(patches()).toBe(0)
  })

  it('off, with allowDrop, on an update that drops nothing: it works', async () => {
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'A' }, 'pmk') })
    saveMap(resolveMapPath(null, cwd), { __CLS__1: 'A', __FN__3: 'c' }, { force: true })
    const r = await callToolAsync('maps_update', { id: row.id, allowDrop: true }, ctx)
    expect(r.isError ?? false, r.text).toBe(false)
  })
})
