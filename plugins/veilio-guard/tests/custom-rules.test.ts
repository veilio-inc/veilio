// Spec 065 US4: the guard applies the account's custom rules, as the CLI
// does. Before it, its only rule was its own keep rule for third-party names,
// and since spec 064 an ordinary-word codename (`phoenix`) stayed readable
// with nothing the user could do about it in Claude Code.
import { expect, test } from 'claude-code/testing'
import {
  CANARY,
  eventOf,
  mapFile,
  project,
  recorded,
  recordedRaw,
  recordedPrompt,
  ROOT,
  res,
} from './helpers.ts'
import { COLD_FILES } from './fixtures/cold.ts'
import type { Fields } from './fixtures/recorded.ts'
import type { TestOn } from './kit.ts'
import { readGuardRules } from '../lib/rules.ts'

const HOME = '/home/dev'
const CREDENTIAL = `${HOME}/.veilio/credential.json`
const RULES = `${HOME}/.veilio/rules.json`
const MAP = `${ROOT}/.veilio/map.json`
const ME = { instance: 'https://veilio.dev', account: 'dev@example.com' }

const PHOENIX = {
  id: 'r1',
  scope: 'personal',
  team_id: null,
  type: 'replace',
  name: 'codename',
  pattern: '^phoenix$',
  placeholder: '__CODENAME__',
  enabled: true,
  sort_order: 0,
}
const KEEP_CANARY = {
  id: 'r2',
  scope: 'team',
  team_id: 't1',
  type: 'whitelist',
  name: 'our product',
  pattern: `^${CANARY}$`,
  enabled: true,
  sort_order: 0,
}

function cache(rules: unknown[], owner = ME, skipped?: Record<string, number>): string {
  return JSON.stringify({ ...owner, pulledAt: '2026-10-30T10:00:00Z', rules, skipped })
}

function home(on: TestOn): void {
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
}

const PMK = `${HOME}/.veilio/personal-maps-key.json`
const TEAM_KEYS = `${HOME}/.veilio/team-keys.json`
const KEY32 = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)))
const FUTURE = '2999-01-01T00:00:00.000Z'
const PAST = '2000-01-01T00:00:00.000Z'
const pmk = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, ...ME, expiresAt: FUTURE, key: KEY32, ...o })
const teamKeys = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({
    v: 1,
    ...ME,
    teamId: 't1',
    expiresAt: FUTURE,
    keys: [{ version: 1, key: KEY32 }],
    ...o,
  })

/** Signed in, the cache pulled, and both keys still held - as after
 *  `veilio vault unlock`, `veilio team unlock` and `veilio rules pull`. */
function signedIn(rules: unknown[], owner = ME): Record<string, string> {
  return {
    [CREDENTIAL]: JSON.stringify({ token: 't', ...ME }),
    [RULES]: cache(rules, owner),
    [PMK]: pmk(),
    [TEAM_KEYS]: teamKeys(),
  }
}

/** The same files with one key file replaced, or removed (null). */
function withKey(path: string, file: string | null, rules: unknown[]): Record<string, string> {
  const all = signedIn(rules)
  if (file === null) delete all[path]
  else all[path] = file
  return all
}

function files(read: Record<string, string>) {
  return (path: string) =>
    path in read ? Promise.resolve(read[path]!) : Promise.reject(new Error('ENOENT'))
}

// ── the cache, read ─────────────────────────────────────────────────────────

test("rules load only when the cache's instance and account match the credential", async () => {
  const r = await readGuardRules(files(signedIn([PHOENIX])), HOME)
  expect(r.state).toBe('applied')
  expect(r.rules.map((x) => x.id)).toEqual(['r1'])
})

test('none are loaded when the cache is missing, damaged or from another account', async () => {
  const cred = { [CREDENTIAL]: JSON.stringify({ token: 't', ...ME }) }
  expect((await readGuardRules(files(cred), HOME)).state).toBe('none-pulled')
  expect((await readGuardRules(files({ ...cred, [RULES]: '{"inst' }), HOME)).state).toBe(
    'none-pulled'
  )
  expect(
    (await readGuardRules(files({ ...cred, [RULES]: cache([{ type: 'replace' }]) }), HOME)).state
  ).toBe('none-pulled')
  const other = await readGuardRules(
    files(signedIn([PHOENIX], { ...ME, account: 'someone@else.com' })),
    HOME
  )
  expect(other).toMatchObject({ state: 'other-account', rules: [] })
  const elsewhere = await readGuardRules(
    files(signedIn([PHOENIX], { ...ME, instance: 'https://other.example' })),
    HOME
  )
  expect(elsewhere.state).toBe('other-account')
  // Signed out: the cache belongs to no one here.
  expect((await readGuardRules(files({ [RULES]: cache([PHOENIX]) }), HOME)).state).toBe(
    'other-account'
  )
  expect((await readGuardRules(files(signedIn([PHOENIX])), undefined)).state).toBe('none-pulled')
})

test('an unsupported pattern or an engine placeholder in a hand-edited cache is skipped and counted', async () => {
  const backref = { ...PHOENIX, id: 'bad1', pattern: '(a)\\1' }
  const engineBase = { ...PHOENIX, id: 'bad2', placeholder: '__CLS__' }
  const read = files({
    ...signedIn([]),
    [RULES]: cache([PHOENIX, backref, engineBase], ME, { vaultLocked: 2, refused: 1 }),
  })
  const r = await readGuardRules(read, HOME)
  expect(r.rules.map((x) => x.id)).toEqual(['r1'])
  expect(r.skipped).toEqual({ vaultLocked: 2, teamLocked: 0, unopenable: 0, refused: 3 })
})

// ── only while the key is held (spec 065 FR-006) ───────────────────────────
// The same table as the CLI's rules-lock-purge.test.ts: one definition of
// "held" (keysHeld in packages/cli/src/rules.ts), mirrored in lib/rules.ts.

const PERSONAL_TABLE: [string, boolean, string | null][] = [
  ['absent', false, null],
  ['damaged JSON', false, '{"v":'],
  ['wrong version', false, pmk({ v: 2 })],
  ['another account', false, pmk({ account: 'ada@example.test' })],
  ['another instance', false, pmk({ instance: 'https://other.test' })],
  ['expired', false, pmk({ expiresAt: PAST })],
  ['unparseable expiry', false, pmk({ expiresAt: 'soon' })],
  ['a key of the wrong length', false, pmk({ key: btoa('x'.repeat(16)) })],
  ['a key that is not base64', false, pmk({ key: '***' })],
  ['valid', true, pmk()],
]
for (const [name, held, file] of PERSONAL_TABLE) {
  test(`personal-maps key ${name}: held = ${held}`, async () => {
    const r = await readGuardRules(files(withKey(PMK, file, [PHOENIX, KEEP_CANARY])), HOME)
    expect(r.rules.map((x) => x.id)).toEqual(held ? ['r1', 'r2'] : ['r2'])
    expect(r.skipped.vaultLocked).toBe(held ? 0 : 1)
  })
}

const TEAM_TABLE: [string, boolean, string | null][] = [
  ['absent', false, null],
  ['damaged JSON', false, '['],
  ['another account', false, teamKeys({ account: 'ada@example.test' })],
  ['expired', false, teamKeys({ expiresAt: PAST })],
  ['another team', false, teamKeys({ teamId: 'team-2' })],
  ['no keys', false, teamKeys({ keys: [] })],
  ['only damaged keys', false, teamKeys({ keys: [{ version: 1, key: btoa('x'.repeat(8)) }] })],
  [
    'one damaged key and one good',
    true,
    teamKeys({
      keys: [
        { version: 1, key: '***' },
        { version: 2, key: KEY32 },
      ],
    }),
  ],
  ['valid', true, teamKeys()],
]
for (const [name, held, file] of TEAM_TABLE) {
  test(`team key ${name}: held = ${held}`, async () => {
    const r = await readGuardRules(files(withKey(TEAM_KEYS, file, [PHOENIX, KEEP_CANARY])), HOME)
    expect(r.rules.map((x) => x.id)).toEqual(held ? ['r1', 'r2'] : ['r1'])
    expect(r.skipped.teamLocked).toBe(held ? 0 : 1)
  })
}

test('after vault lock a cached personal rule is not applied, and counts as vaultLocked', async ($, on) => {
  home(on)
  // `veilio vault lock` removed the key; the cache still names the rule.
  project(on, withKey(PMK, null, [PHOENIX]))
  const bash = recordedRaw('Bash')
  const r = bash.r as { result: Record<string, unknown> }
  on('tool.call', () => ({ ...r, result: { ...r.result, stdout: 'deploying phoenix' } }))
  const out = JSON.stringify(await $.tool.call(eventOf(bash)))
  expect(out).not.toContain('__CODENAME__')
  expect((await readGuardRules(files(withKey(PMK, null, [PHOENIX])), HOME)).skipped).toMatchObject({
    vaultLocked: 1,
  })
})

test('an expired personal-maps key leaves a cached personal rule unapplied, with no lock command', async ($, on) => {
  home(on)
  project(on, withKey(PMK, pmk({ expiresAt: PAST }), [PHOENIX]))
  const bash = recordedRaw('Bash')
  const r = bash.r as { result: Record<string, unknown> }
  on('tool.call', () => ({ ...r, result: { ...r.result, stdout: 'deploying phoenix' } }))
  expect(JSON.stringify(await $.tool.call(eventOf(bash)))).not.toContain('__CODENAME__')
})

test('after team lock a cached team rule is not applied, and counts as teamLocked', async ($, on) => {
  home(on)
  project(on, { ...withKey(TEAM_KEYS, null, [KEEP_CANARY]), [MAP]: mapFile({ __CLS__1: CANARY }) })
  const read = recorded('Read')
  on('tool.call', () => read.r)
  const fromRead: string = res(await $.tool.call(eventOf(read))).file.content
  expect(fromRead).not.toContain(CANARY)
  const r = await readGuardRules(files(withKey(TEAM_KEYS, null, [KEEP_CANARY])), HOME)
  expect(r.skipped).toMatchObject({ teamLocked: 1, vaultLocked: 0 })
})

// ── applied wherever the guard masks ───────────────────────────────────────

test('a replace rule masks an ordinary-word codename in a Read', async ($, on) => {
  home(on)
  const p = project(on, signedIn([PHOENIX]))
  on('tool.call', () => ({
    ref: 1,
    result: {
      type: 'text',
      file: {
        filePath: `${ROOT}/src/deploy.ts`,
        content: 'export const phoenix = 1\nexport const ledger = phoenix\n',
        numLines: 2,
        startLine: 1,
        totalLines: 2,
      },
    },
    isReadOnly: true,
  }))
  const out = await $.tool.call({
    tool: 'Read',
    tool_use_id: 't1',
    file_path: `${ROOT}/src/deploy.ts`,
  })
  const seen: string = res(out).file.content
  expect(seen).not.toContain('phoenix')
  expect(seen).toContain('__CODENAME__1')
  expect(JSON.parse(p.files[MAP]!).map.__CODENAME__1).toBe('phoenix')
})

test('a replace rule masks the codename in command output, and the placeholder restores in an edit', async ($, on) => {
  home(on)
  const p = project(on, signedIn([PHOENIX]))
  const bash = recordedRaw('Bash')
  const r = bash.r as { result: Record<string, unknown> }
  const edit = recorded('Edit')
  const seen: Fields[] = []
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit') {
      seen.push(e)
      return edit.r
    }
    return { ...r, result: { ...r.result, stdout: 'deploying phoenix from ledger/main' } }
  })
  const out = JSON.stringify(await $.tool.call(eventOf(bash)))
  expect(out).not.toContain('phoenix')
  expect(out).toContain('__CODENAME__1')
  expect(out).toContain('ledger/main')
  expect(JSON.parse(p.files[MAP]!).map.__CODENAME__1).toBe('phoenix')
  await $.tool.call({
    ...eventOf(edit),
    old_string: '__CODENAME__1',
    new_string: 'x = __CODENAME__1',
  })
  expect(seen[0].old_string).toBe('phoenix')
  expect(seen[0].new_string).toBe('x = phoenix')
})

test('a replace rule masks the codename in a typed prompt', async ($, on) => {
  home(on)
  const p = project(on, signedIn([PHOENIX]))
  const sent: Fields[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e)
    return { text: e.text }
  })
  await $.prompt.submit({ ...recordedPrompt('prompt.submit').e, text: 'Why does phoenix fail?' })
  expect(sent[0].text).toBe('Why does __CODENAME__1 fail?')
  expect(JSON.parse(p.files[MAP]!).map.__CODENAME__1).toBe('phoenix')
})

test('a rule-made entry the map holds stays masked in the readable view, though an ordinary word', async ($, on) => {
  home(on)
  // The map holds the engine's own entry from before the rule: 064 shows it.
  project(on, { ...signedIn([PHOENIX]), [MAP]: mapFile({ __STR__3: 'phoenix' }) })
  const bash = recordedRaw('Bash')
  const r = bash.r as { result: Record<string, unknown> }
  on('tool.call', () => ({ ...r, result: { ...r.result, stdout: 'phoenix is up' } }))
  const out = JSON.stringify(await $.tool.call(eventOf(bash)))
  expect(out).not.toContain('phoenix')
  expect(out).toMatch(/__CODENAME__\d+ is up/)
})

test('a whitelist rule keeps a distinctive name readable in a Read, in output and in a prompt', async ($, on) => {
  home(on)
  project(on, { ...signedIn([KEEP_CANARY]), [MAP]: mapFile({ __CLS__1: CANARY }) })
  const read = recorded('Read')
  const bash = recordedRaw('Bash')
  const r = bash.r as { result: Record<string, unknown> }
  on('tool.call', (_, e) =>
    e.tool === 'Read' ? read.r : { ...r, result: { ...r.result, stdout: `${CANARY} passed` } }
  )
  const sent: Fields[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e)
    return { text: e.text }
  })
  const fromRead: string = res(await $.tool.call(eventOf(read))).file.content
  expect(fromRead).toContain(`class ${CANARY}`)
  expect(fromRead).not.toContain('settledTotal')
  expect(JSON.stringify(await $.tool.call(eventOf(bash)))).toContain(`${CANARY} passed`)
  await $.prompt.submit({ ...recordedPrompt('prompt.submit').e, text: `Fix ${CANARY}` })
  expect(sent[0].text).toBe(`Fix ${CANARY}`)
})

test('rules from another account are not applied', async ($, on) => {
  home(on)
  project(on, signedIn([PHOENIX], { ...ME, account: 'someone@else.com' }))
  const bash = recordedRaw('Bash')
  const r = bash.r as { result: Record<string, unknown> }
  on('tool.call', () => ({ ...r, result: { ...r.result, stdout: 'deploying phoenix' } }))
  const out = JSON.stringify(await $.tool.call(eventOf(bash)))
  expect(out).toContain('deploying phoenix')
  expect(out).not.toContain('__CODENAME__')
})

test("the guard's own keep rule still applies, ahead of the account's rules", async ($, on) => {
  home(on)
  // A replace rule that would take the package's name: the keep rule wins.
  const vitest = { ...PHOENIX, id: 'r3', pattern: '^(?:vitest|luhnValid)$' }
  project(on, { ...COLD_FILES, ...signedIn([vitest]) })
  on('session.start', () => ({ cwd: ROOT }))
  const content = COLD_FILES[`${ROOT}/tests/secrets.test.ts`]!
  on('tool.call', () => ({
    ref: 1,
    result: {
      type: 'text',
      file: {
        filePath: `${ROOT}/tests/secrets.test.ts`,
        content,
        numLines: 7,
        startLine: 1,
        totalLines: 7,
      },
    },
    isReadOnly: true,
  }))
  await $.session.start({ surface: 'terminal', isInteractive: false, cwd: ROOT })
  const out = await $.tool.call({
    tool: 'Read',
    tool_use_id: 't_t',
    file_path: `${ROOT}/tests/secrets.test.ts`,
  })
  const seen: string = res(out).file.content
  expect(seen).toContain("import { describe, expect, it } from 'vitest'")
  expect(seen).not.toContain('luhnValid')
  expect(seen).toContain('__CODENAME__')
})
