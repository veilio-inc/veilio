// /veilio off is held in memory for one session (security audit 2026-11-11,
// H1): a new Guard over the same disk starts on, and nothing is stored.
import { expect, it } from 'vitest'
import { Guard, type GuardIO } from '../../plugins/veilio-guard/lib/guard.ts'

const ROOT = '/work/project'
const HOME = '/home/dev'
const STATE = `${HOME}/.veilio/guard-state.json`

function disk(extra: Record<string, string> = {}) {
  const files: Record<string, string> = {
    [`${ROOT}/.git/HEAD`]: 'ref: refs/heads/main\n',
    [`${ROOT}/.veilio/map.json`]: `${JSON.stringify({ version: 1, map: {} })}\n`,
    ...extra,
  }
  const io: GuardIO = {
    read: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`)
      return files[p]!
    },
    write: async (p, t) => void (files[p] = t),
    exists: async (p) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    realPath: async (p) => p,
    list: async () => ['README.md'],
    listVeilio: async () => [],
    remove: async (p) => void delete files[p],
  }
  return { io, files }
}
const start = async (io: GuardIO) => {
  const g = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await g.load(ROOT, HOME)
  return g
}

it('/veilio off holds in the session, stores nothing, and a new session starts on', async () => {
  const { io, files } = disk()
  const before = JSON.stringify(files)
  const first = await start(io)
  await first.setEnabled(false)
  expect(first.state).toBe('off')
  expect(JSON.stringify(files)).toBe(before)
  const second = await start(io)
  expect(second.state).toBe('on')
})

it('an off record an agent writes, by any program, is never honoured', async () => {
  const { io, files } = disk()
  const g = await start(io)
  expect(g.state).toBe('on')
  files[STATE] = JSON.stringify({ version: 1, projects: { [ROOT]: { enabled: false } } })
  expect((await start(io)).state).toBe('on')
})

it('an older version’s record is removed, with its secret, and noted for the session', async () => {
  const { io, files } = disk({
    [STATE]: JSON.stringify({ version: 1, projects: { [ROOT]: { enabled: false, mac: 'x' } } }),
    [`${HOME}/.veilio/guard-secret`]: 'ab'.repeat(32),
  })
  const g = await start(io)
  expect(g.state).toBe('on')
  expect(g.legacyOffRecord).toBe(true)
  expect(files[STATE]).toBeUndefined()
  expect(files[`${HOME}/.veilio/guard-secret`]).toBeUndefined()
  expect((await start(io)).legacyOffRecord).toBe(false)
})

it('a guard-state.json that is not JSON is removed and read as nothing', async () => {
  const { io, files } = disk({ [STATE]: '{"version":' })
  const g = await start(io)
  expect(g.state).toBe('on')
  expect(g.legacyOffRecord).toBe(false)
  expect(files[STATE]).toBeUndefined()
})
