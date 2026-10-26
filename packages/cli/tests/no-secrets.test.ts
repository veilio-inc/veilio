import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toBase64 } from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { STORE_DIR, STORE_FILE, saveMap } from '../src/store.js'
import {
  FakeCloud,
  PASSPHRASE,
  PMK_RAW,
  TEAMMATE,
  TEAM_RAW,
  sealPersonal,
  sealTeam,
  signIn,
} from './helpers/fake-cloud.js'

/**
 * FR-009 for the terminal (spec 052): no Cloud command prints a passphrase, a
 * key, a wrapped key or an encrypted map body - on stdout or stderr, answer or
 * refusal. The same scan the MCP server's results get (T023), over every Cloud
 * command this spec adds or changes.
 */

let home: string
let cwd: string
let cloud: FakeCloud

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-cli-scan-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-cli-scan-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

it('no command output holds a secret', async () => {
  await cloud.withVault()
  await cloud.withPmkWrap()
  signIn(home, { team: true })
  const mine = cloud.add({ name: 'mine', map_data: await sealPersonal({ __CLS__1: 'A' }, 'pmk') })
  const old = cloud.add({ name: 'old', map_data: await sealPersonal({ __CLS__2: 'B' }, 'vault') })
  const team = cloud.add({
    scope: 'team',
    name: 'shared',
    map_data: await sealTeam({ __CLS__1: 'A' }),
  })
  const theirs = cloud.add({
    scope: 'team',
    owner: TEAMMATE,
    map_data: await sealTeam({ __CLS__7: 'C' }),
  })
  saveMap(join(cwd, STORE_DIR, STORE_FILE), { __CLS__1: 'A', __FN__3: 'd' }, { force: true })
  const secrets = [
    PASSPHRASE,
    toBase64(PMK_RAW),
    toBase64(TEAM_RAW),
    cloud.pmkWrap!,
    (JSON.parse(cloud.pmkWrap!) as { data: string }).data,
    ...[mine, old, team, theirs].flatMap((m) => [
      m.map_data,
      (JSON.parse(m.map_data) as { data: string }).data,
    ]),
  ]

  let all = ''
  for (const argv of [
    ['vault', 'unlock'],
    ['maps', 'list'],
    ['maps', 'pull', mine.id, '--force'],
    ['maps', 'pull', old.id],
    ['maps', 'pull', theirs.id, '--force'],
    ['maps', 'update', mine.id],
    ['maps', 'update', team.id, '--allow-drop'],
    ['maps', 'update', theirs.id],
    ['maps', 'push', 'p'],
    ['maps', 'push', '--team', 't'],
    ['projects'],
    ['projects', 'use', 'tools'],
    ['whoami'],
    ['maps', 'rm', mine.id],
    ['vault', 'lock'],
  ]) {
    await main(argv, {
      cwd,
      home,
      stdin: async () => '',
      stdout: (t) => (all += t),
      stderr: (t) => (all += t),
      password: async () => PASSPHRASE,
    })
  }
  expect(all.length).toBeGreaterThan(200)
  expect(secrets.filter((s) => all.includes(s))).toEqual([])
})

describe('the scan can fail', () => {
  it('finds a secret when one is printed', () => {
    expect([PASSPHRASE].filter((s) => `x ${PASSPHRASE} y`.includes(s))).toHaveLength(1)
  })
})
