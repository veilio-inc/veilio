import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeCredential } from '@veilio-inc/cli/credential'
import { handleMessage } from '../src/server.js'
import { SignInWatcher, TOOLS_LIST_CHANGED } from '../src/sign-in-watch.js'
import { signIn } from '../../cli/tests/helpers/fake-cloud.js'

/**
 * The tool list changes with the sign-in (FR-023), so the server says so
 * (spec 052, founder decision 2026-10-25): `listChanged: true`, and a
 * `notifications/tools/list_changed` whenever the person signs in or out
 * while it runs. A client that fetched the list once at start would otherwise
 * never see the map tools after `veilio login`, and keep offering them after
 * `veilio logout`.
 */

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-listchanged-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('the capability', () => {
  it('initialize declares the tool list as one that changes', () => {
    const res = handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        cwd: home,
        mapPath: null,
        home,
      }
    )
    expect(
      (res!.result as { capabilities: { tools: { listChanged: boolean } } }).capabilities.tools
    ).toEqual({ listChanged: true })
  })
})

describe('the notification', () => {
  it('is the JSON-RPC notification MCP defines: a method, no id', () => {
    expect(TOOLS_LIST_CHANGED).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    })
    expect(TOOLS_LIST_CHANGED).not.toHaveProperty('id')
  })

  it('is sent once on sign-in, once on sign-out, and never when nothing changed', () => {
    let sent = 0
    const watcher = new SignInWatcher(home, () => sent++)
    expect(watcher.check()).toBe(false)
    expect(sent).toBe(0)
    signIn(home)
    expect(watcher.check()).toBe(true)
    expect(watcher.check()).toBe(false)
    expect(sent).toBe(1)
    removeCredential(home)
    expect(watcher.check()).toBe(true)
    expect(sent).toBe(2)
  })

  it('a server started signed in notifies on logout', () => {
    signIn(home)
    let sent = 0
    const watcher = new SignInWatcher(home, () => sent++)
    removeCredential(home)
    watcher.check()
    expect(sent).toBe(1)
  })
})
