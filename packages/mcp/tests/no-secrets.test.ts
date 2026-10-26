import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toBase64 } from '@veilio-inc/engine'
import { resolveMapPath, saveMap } from '@veilio-inc/cli/store'
import { writeCredential } from '@veilio-inc/cli/credential'
import { respond, type JsonRpcResponse } from '../src/server.js'
import { CLOUD_TOOLS, TOOLS, callToolAsync, type ToolContext } from '../src/tools.js'
import {
  FakeCloud,
  INSTANCE,
  ME,
  PASSPHRASE,
  PMK_RAW,
  TEAMMATE,
  TEAM_RAW,
  sealPersonal,
  sealTeam,
  signIn,
} from '../../cli/tests/helpers/fake-cloud.js'

/**
 * FR-009 / SC-003 (spec 052, T023): no tool result - success or refusal -
 * carries a passphrase, a key, a wrapped key, a session token or a map's
 * encrypted body. Nor, for a clash, the real names behind the placeholders.
 *
 * Checked by calling EVERY tool, in states that produce both answers and
 * refusals, with a store full of known secrets, and searching each result
 * for each secret. A list of the tools is not hand-written here: it is read
 * from the server, so a tool added later is scanned without anybody
 * remembering to add it.
 */

const TOKEN = 'session-token-7f3a9c2e5b1d4f6a8c0e2b4d6f8a0c2e'
let home: string
let cwd: string
let cloud: FakeCloud
let secrets: { label: string; value: string }[]

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'veilio-scan-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-scan-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  writeFileSync(join(cwd, 'a.ts'), 'export class Ledger { settle() {} }\n')
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
  await cloud.withVault()
  await cloud.withPmkWrap()
  signIn(home, { pmk: true, team: true })
  writeCredential({ token: TOKEN, account: ME, instance: INSTANCE }, home)

  const personal = cloud.add({
    name: 'mine',
    map_data: await sealPersonal({ __CLS__1: 'Ledger' }, 'pmk'),
  })
  const old = cloud.add({ name: 'old', map_data: await sealPersonal({ __CLS__2: 'Old' }, 'vault') })
  const team = cloud.add({
    scope: 'team',
    name: 'shared',
    map_data: await sealTeam({ __CLS__1: 'Ledger' }),
  })
  const theirs = cloud.add({
    scope: 'team',
    owner: TEAMMATE,
    name: 'theirs',
    map_data: await sealTeam({ __CLS__9: 'TheirSecretRouter' }),
  })
  saveMap(
    resolveMapPath(null, cwd),
    { __CLS__1: 'Ledger', __CLS__9: 'MySecretRouter' },
    { force: true }
  )

  secrets = [
    { label: 'passphrase', value: PASSPHRASE },
    { label: 'personal-maps key', value: toBase64(PMK_RAW) },
    { label: 'team key', value: toBase64(TEAM_RAW) },
    { label: 'wrapped personal-maps key', value: cloud.pmkWrap! },
    {
      label: 'wrapped key ciphertext',
      value: (JSON.parse(cloud.pmkWrap!) as { data: string }).data,
    },
    { label: 'session token', value: TOKEN },
    { label: 'vault verifier', value: cloud.vault!.verifier },
    ...[personal, old, team, theirs].flatMap((m) => [
      { label: `${m.name} envelope`, value: m.map_data },
      { label: `${m.name} ciphertext`, value: (JSON.parse(m.map_data) as { data: string }).data },
      { label: `${m.name} iv`, value: (JSON.parse(m.map_data) as { iv: string }).iv },
    ]),
    { label: 'a teammate’s real name behind a clash', value: 'TheirSecretRouter' },
    { label: 'this map’s real name behind a clash', value: 'MySecretRouter' },
  ]
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

/** Arguments that drive each tool into an answer, and into each refusal it
 *  has that a state here can produce. */
function argSets(name: string, ids: string[]): Record<string, unknown>[] {
  switch (name) {
    case 'maps_pull':
      return ids.flatMap((id) => [{ id }, { id, force: true }, { id: 'nope' }])
    case 'maps_update':
      return ids.flatMap((id) => [{ id }, { id, allowDrop: true }, { id: 'nope' }])
    case 'maps_remove':
      return ids.flatMap((id) => [
        { id, confirmName: 'wrong' },
        { id, confirmName: 'mine' },
      ])
    case 'maps_create':
      return [
        { name: 'x', scope: 'personal' },
        { name: 'y', scope: 'team' },
      ]
    case 'projects_use':
      return [{ project: 'tools' }, { project: 'payroll' }]
    case 'anonymize_file':
    case 'scan_secrets':
      return [{ path: 'a.ts' }]
    case 'anonymize_text':
      return [{ text: 'export class Ledger {}' }]
    case 'restore_text':
      // Restoring real names is this tool's job; __CLS__9's is one of the
      // strings scanned for, so only __CLS__1 is asked for.
      return [{ text: '__CLS__1' }]
    default:
      return [{}]
  }
}

function leaks(text: string): string[] {
  return secrets.filter((s) => text.includes(s.value)).map((s) => s.label)
}

describe('no secret in any tool result (FR-009)', () => {
  it.each([false, true])('every tool, every outcome, destructive=%s', async (destructive) => {
    const ctx: ToolContext = { cwd, mapPath: null, home, destructive }
    const listed = (await respond(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      ctx
    )) as JsonRpcResponse
    const names = (listed.result as { tools: { name: string }[] }).tools.map((t) => t.name)
    expect(names.sort()).toEqual([...TOOLS, ...CLOUD_TOOLS].map((t) => t.name).sort())
    expect(leaks(JSON.stringify(listed))).toEqual([])

    const ids = cloud.maps.map((m) => m.id)
    let calls = 0
    let errors = 0
    const succeeded = new Set<string>()
    for (const name of names) {
      for (const args of argSets(name, ids)) {
        const r = await callToolAsync(name, args, ctx)
        calls++
        if (r.isError) errors++
        else succeeded.add(name)
        expect(leaks(r.text), `${name} ${JSON.stringify(args)} -> ${r.text}`).toEqual([])
        // Through the wire as well: what an MCP client actually receives.
        const wire = await respond(
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
          ctx
        )
        expect(leaks(JSON.stringify(wire)), name).toEqual([])
      }
    }
    // The scan saw both kinds of answer, or it proved nothing about one.
    expect(calls).toBeGreaterThan(30)
    expect(errors).toBeGreaterThan(5)
    expect(calls - errors).toBeGreaterThan(5)
    // Each tool's success path was scanned, not only its refusals - a leak
    // in a successful pull went unseen until this was added (mutation test).
    const mustSucceed = [
      'maps_list',
      'maps_create',
      'team_status',
      'projects_list',
      'projects_use',
      // Every update in these states drops or clashes, so it goes through
      // only when drops are allowed.
      // and every pull here overwrites local entries, so it needs force.
      ...(destructive ? ['maps_pull', 'maps_update', 'maps_remove'] : []),
    ]
    expect(mustSucceed.filter((n) => !succeeded.has(n))).toEqual([])
  })

  it('a clash refusal is among the results scanned, and names its placeholder', async () => {
    const ctx: ToolContext = { cwd, mapPath: null, home, destructive: false }
    const team = cloud.maps.find((m) => m.name === 'shared')!
    const r = await callToolAsync('maps_update', { id: team.id }, ctx)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('__CLS__9')
    expect(leaks(r.text)).toEqual([])
  })
})
