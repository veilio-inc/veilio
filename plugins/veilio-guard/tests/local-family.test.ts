// Spec 066 US1: a guard holding no usable block numbers new names in the
// checkout's local family, `__LOCAL_<tag>_<KIND>__n`, never above the map -
// where the next teammate's block starts. In the spec 065 benchmark
// `__CLS__10088` meant a JDK class to the owner and a temp-directory suffix
// to member m1, and nothing noticed.
import { expect, test } from 'claude-code/testing'
import { mergeAdditions } from '../lib/mapfile.ts'
import { eventOf, mapFile, project, recorded, recordedRaw, res, ROOT } from './helpers.ts'
import type { TestHost, TestOn } from './kit.ts'

const RESERVED = `${ROOT}/.veilio/reserved.json`
const MAP = `${ROOT}/.veilio/map.json`
const reservedFile = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    instance: 'https://veilio.test',
    account: 'me@example.test',
    teamId: 'team-1',
    blocks: {},
    local: { tag: 'K7Q2XA' },
    refused: { reason: 'cap', at: '2026-10-31T10:00:00.000Z', nextAt: '2026-11-01T09:14:00.000Z' },
    ...extra,
  })

const TEAM_FAMILY = /(?<![A-Za-z0-9_])__(?:CLS|FN|VAR)__\d+/
const LOCAL_ANY = /__LOCAL_([A-Z0-9]{6})_(?:CLS|FN|VAR)__\d+/g
const tagsIn = (text: string) => new Set([...text.matchAll(LOCAL_ANY)].map((m) => m[1]))
const saved = (p: { files: Record<string, string> }) =>
  JSON.parse(p.files[MAP]).map as Record<string, string>

async function readOnce($: TestHost, on: TestOn, files: Record<string, string>) {
  const read = recorded('Read')
  const p = project(on, files)
  on('tool.call', () => read.r)
  const content = res(await $.tool.call(eventOf(read))).file.content as string
  return { p, content }
}

test('refused, no block: a Read mints the local family under the checkout’s tag', async ($, on) => {
  const { p, content } = await readOnce($, on, { [RESERVED]: reservedFile() })
  expect(content).toMatch(/__LOCAL_K7Q2XA_(?:CLS|FN|VAR)__\d+/)
  expect(content).not.toMatch(TEAM_FAMILY)
  expect([...tagsIn(content)]).toEqual(['K7Q2XA'])
  expect(Object.keys(saved(p)).every((k) => k.startsWith('__LOCAL_K7Q2XA_'))).toBe(true)
  // The file the CLI wrote is left alone.
  expect(p.files[RESERVED]).toBe(reservedFile())
})

test('refused, no block: a name first met in output is minted local too', async ($, on) => {
  const bash = recordedRaw('Bash')
  project(on, { [RESERVED]: reservedFile() })
  const r = bash.r as { result: Record<string, unknown> }
  on('tool.call', () => ({
    ...r,
    result: { ...r.result, stdout: 'FAIL QuaywardRebalancer: skerryHoldCount was 3' },
  }))
  const out = JSON.stringify(await $.tool.call(eventOf(bash)))
  expect(out).not.toContain('QuaywardRebalancer')
  expect(out).toMatch(/__LOCAL_K7Q2XA_CLS__1/)
  expect(out).not.toMatch(TEAM_FAMILY)
})

test('an unreadable file: local, under one session tag', async ($, on) => {
  const { content } = await readOnce($, on, {
    [RESERVED]: reservedFile({ local: { tag: 'not-a-tag' } }),
  })
  expect(content).not.toMatch(TEAM_FAMILY)
  const tags = tagsIn(content)
  expect(tags.size).toBe(1)
  expect([...tags][0]).not.toBe('not-a-tag')
})

test('a file from an older CLI (no local): its blocks are used, other kinds go local under a session tag', async ($, on) => {
  const older = JSON.stringify({
    version: 1,
    instance: 'https://veilio.test',
    account: 'me@example.test',
    teamId: 'team-1',
    blocks: { __CLS__: { start: 5001, end: 5500 } },
  })
  const { content } = await readOnce($, on, { [RESERVED]: older })
  const cls = [...content.matchAll(/(?<![A-Za-z0-9_])__CLS__(\d+)/g)].map((m) => Number(m[1]))
  expect(cls.length).toBeGreaterThan(0)
  for (const n of cls) expect(n).toBeGreaterThanOrEqual(5001)
  expect(content).not.toMatch(/(?<![A-Za-z0-9_])__(?:FN|VAR)__\d+/)
  expect(tagsIn(content).size).toBe(1)
})

test('no file: numbering is unchanged (signed out, Community Edition)', async ($, on) => {
  const { content } = await readOnce($, on, {})
  expect(content).not.toContain('__LOCAL_')
  expect(content).toMatch(TEAM_FAMILY)
})

test('a block that runs out during a Read sends the rest local, and only those count as outside', async ($, on) => {
  const one = { start: 5001, end: 5001 }
  const { p, content } = await readOnce($, on, {
    [RESERVED]: reservedFile({
      refused: undefined,
      blocks: {
        __CLS__: one,
        __FN__: { start: 7001, end: 7001 },
        __VAR__: { start: 9001, end: 9001 },
      },
    }),
  })
  const map = saved(p)
  const local = Object.keys(map).filter((k) => k.startsWith('__LOCAL_K7Q2XA_'))
  const inBlock = Object.keys(map).filter((k) => /^__(CLS__5001|FN__7001|VAR__9001)$/.test(k))
  expect(local.length).toBeGreaterThan(0)
  expect(inBlock.length).toBeGreaterThan(0)
  expect(local.length + inBlock.length).toBe(Object.keys(map).length)
  expect(content).toContain(local[0])
  const status = await $.command.run({ command: 'veilio', args: '' })
  expect(status.text).toContain(
    `${local.length} name${local.length === 1 ? '' : 's'} outside reserved team numbers`
  )
})

test('a local role entry for an ordinary word reads as a role entry (spec 064)', async ($, on) => {
  const bash = recordedRaw('Bash')
  project(on, {
    [MAP]: mapFile({ __LOCAL_K7Q2XA_VAR__1: 'recent', __LOCAL_K7Q2XA_CLS__2: 'SkerryTariff' }),
  })
  const r = bash.r as { result: Record<string, unknown> }
  on('tool.call', () => ({
    ...r,
    result: { ...r.result, stdout: 'most recent call last: SkerryTariff' },
  }))
  const out = JSON.stringify(await $.tool.call(eventOf(bash)))
  expect(out).toContain('most recent call last')
  expect(out).toContain('__LOCAL_K7Q2XA_CLS__2')
  expect(out).not.toContain('SkerryTariff')
})

test('mergeAdditions: a rule placeholder over a local role entry is not a clash (spec 064/065)', async () => {
  const { merged, conflicts } = mergeAdditions(
    { __LOCAL_K7Q2XA_VAR__1: 'phoenix' },
    { __CODENAME__1: 'phoenix' }
  )
  expect(conflicts).toEqual([])
  expect(merged).toEqual({ __LOCAL_K7Q2XA_VAR__1: 'phoenix', __CODENAME__1: 'phoenix' })
})

test('after a publish, an edit holding the old local placeholder restores through aliases.json', async ($, on) => {
  const edit = recorded('Edit')
  project(on, {
    [MAP]: mapFile({ __VAR__502: 'holdbackDays' }),
    [`${ROOT}/.veilio/aliases.json`]: JSON.stringify({
      version: 1,
      aliases: { __LOCAL_K7Q2XA_VAR__1: 'holdbackDays' },
    }),
  })
  const seen: Record<string, unknown>[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return edit.r
  })
  await $.tool.call({
    ...eventOf(edit),
    old_string: 'const __LOCAL_K7Q2XA_VAR__1 =',
    new_string: 'const __VAR__502 =',
  })
  expect(seen[0]?.old_string).toBe('const holdbackDays =')
  expect(seen[0]?.new_string).toBe('const holdbackDays =')
})

test('an edit holding another checkout’s local placeholder is refused, as any unknown one', async ($, on) => {
  const edit = recorded('Edit')
  project(on, { [MAP]: mapFile({ __VAR__502: 'holdbackDays' }) })
  let ran = false
  on('tool.call', () => {
    ran = true
    return edit.r
  })
  await $.tool.call({
    ...eventOf(edit),
    old_string: 'const __LOCAL_ZZ9QQ1_VAR__1 =',
    new_string: 'const x =',
  })
  expect(ran).toBe(false)
})

test('a reload after a publish redrew the tag mints under the new tag', async ($, on) => {
  const read = recorded('Read')
  const p = project(on, { [RESERVED]: reservedFile() })
  on('tool.call', () => read.r)
  await $.tool.call(eventOf(read))
  // A publish renumbered every local entry and drew a new tag.
  p.files[MAP] = mapFile({})
  p.files[RESERVED] = reservedFile({ local: { tag: 'B7B7B7' } })
  await $.command.run({ command: 'veilio', args: 'off' })
  await $.command.run({ command: 'veilio', args: 'on' })
  const content = res(await $.tool.call(eventOf(read))).file.content as string
  expect([...tagsIn(content)]).toEqual(['B7B7B7'])
})

// Code review of spec 066: a CLI publish while the session runs renumbers the
// guard's local entries into aliases.json and redraws the tag. The guard
// re-read only the map, kept its tag, its local counter restarted at 1, and
// it minted a retired placeholder again for another name - one the model's
// context still read as the old name.
async function publishMidSession(
  $: TestHost,
  on: TestOn,
  reserved: string,
  newReserved: (tag: string) => string
) {
  const bash = recordedRaw('Bash')
  const p = project(on, { [RESERVED]: reserved })
  const r = bash.r as { result: Record<string, unknown> }
  let stdout = 'FAIL HoldbackLedger'
  const edit = recorded('Edit')
  const edits: Record<string, unknown>[] = []
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit') {
      edits.push(e)
      return edit.r
    }
    return { ...r, result: { ...r.result, stdout } }
  })
  const first = JSON.stringify(await $.tool.call(eventOf(bash)))
  const retired = /__LOCAL_([A-Z0-9]{6})_CLS__1/.exec(first)
  if (!retired) throw new Error(`nothing minted locally: ${first}`)
  // What `veilio maps push --team` leaves on disk.
  p.files[MAP] = mapFile({ __CLS__502: 'HoldbackLedger' })
  p.files[`${ROOT}/.veilio/aliases.json`] = JSON.stringify({
    version: 1,
    aliases: { [retired[0]]: 'HoldbackLedger' },
  })
  p.files[RESERVED] = newReserved(retired[1])
  stdout = 'FAIL QuaywardRebalancer'
  const outs: string[] = []
  for (let i = 0; i < 3; i++) outs.push(JSON.stringify(await $.tool.call(eventOf(bash))))
  return { retired: retired[0], oldTag: retired[1], outs, p, edit, edits }
}

test('after a CLI publish mid-session, the guard never mints a retired local placeholder again, and takes the new tag', async ($, on) => {
  const { retired, outs } = await publishMidSession($, on, reservedFile(), () =>
    reservedFile({ local: { tag: 'B7B7B7' } })
  )
  for (const out of outs) expect(out).not.toContain(retired)
  expect(outs.join()).toMatch(/__LOCAL_B7B7B7_CLS__1/)
})

test('with no tag in the file (a session tag), a retired placeholder is never minted again either', async ($, on) => {
  const noTag = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 1,
      instance: 'https://veilio.test',
      account: 'me@example.test',
      teamId: 'team-1',
      blocks: {},
      ...extra,
    })
  const { retired, oldTag, outs } = await publishMidSession($, on, noTag(), () => noTag())
  for (const out of outs) expect(out).not.toContain(retired)
  // The session tag is redrawn once its placeholders are retired.
  expect(outs.join()).not.toContain(`__LOCAL_${oldTag}_`)
})

test('after a CLI publish mid-session, an edit with the retired placeholder restores through the new aliases', async ($, on) => {
  const { retired, edit, edits } = await publishMidSession($, on, reservedFile(), () =>
    reservedFile({ local: { tag: 'B7B7B7' } })
  )
  await $.tool.call({ ...eventOf(edit), old_string: `new ${retired}()`, new_string: 'x' })
  expect(edits.at(-1)?.old_string).toBe('new HoldbackLedger()')
})
