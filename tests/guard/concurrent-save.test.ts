// Spec 093 item 6: two guard sessions over one project's map. The validation
// tests of the finding "two sessions can give one placeholder to two names".
// The file API a mod gets has no rename and no lock, so what the guard can do
// is read the file again right before it writes (COVERAGE.md, "Two programs
// saving the map in the same instant").
import { expect, it } from 'vitest'
import { Guard, type GuardIO } from '../../plugins/veilio-guard/lib/guard.ts'

const ROOT = '/work/project'
const MAP = `${ROOT}/.veilio/map.json`

type Disk = Record<string, string>
const disk = (): Disk => ({
  [`${ROOT}/.git/HEAD`]: 'ref: refs/heads/main\n',
  [MAP]: `${JSON.stringify({ version: 1, map: {} }, null, 2)}\n`,
})

/** One session's view of the disk. `afterMapRead` runs once, after this
 *  session has read the map and before it gets the text it read. */
function session(files: Disk) {
  const hook = { afterMapRead: null as null | (() => Promise<unknown>) }
  const io: GuardIO = {
    read: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`)
      const text = files[p]!
      if (p === MAP && hook.afterMapRead) {
        const run = hook.afterMapRead
        hook.afterMapRead = null
        await run()
      }
      return text
    },
    write: async (p, t) => void (files[p] = t),
    exists: async (p) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    realPath: async (p) => p,
    list: async () => ['README.md'],
    listVeilio: async () => [],
  }
  return { io, hook }
}

async function start(io: GuardIO): Promise<Guard> {
  const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await guard.load(ROOT)
  return guard
}

/** The session reads a file that declares `name`; the placeholder the model is shown. */
async function reads(guard: Guard, file: string, name: string): Promise<string> {
  const path = `${ROOT}/src/${file}`
  const out = await guard.afterTool(
    'Read',
    { tool: 'Read', file_path: path },
    {
      result: {
        type: 'text',
        file: {
          filePath: path,
          content: `export class ${name} {}\n`,
          numLines: 1,
          startLine: 1,
          totalLines: 1,
        },
      },
    },
    Date.now() + 5000
  )
  expect(JSON.stringify(out)).not.toContain(name)
  return /__CLS__\d+/.exec(JSON.stringify(out))![0]
}

const saved = (files: Disk) => (JSON.parse(files[MAP]!) as { map: Record<string, string> }).map

it('both sessions loaded the map before either saved: both names are saved, under different placeholders', async () => {
  const files = disk()
  const a = await start(session(files).io)
  const b = await start(session(files).io)
  const shownA = await reads(a, 'a.ts', 'QuasarLedgerFake')
  const shownB = await reads(b, 'b.ts', 'NebulaRouterFake')
  expect(shownA).not.toBe(shownB)
  expect(saved(files)).toMatchObject({ [shownA]: 'QuasarLedgerFake', [shownB]: 'NebulaRouterFake' })
})

it('another session saves between this one’s read of the map and its write: both names are saved, under different placeholders', async () => {
  const files = disk()
  const first = session(files)
  const a = await start(first.io)
  const b = await start(session(files).io)
  let shownB = ''
  first.hook.afterMapRead = async () => {
    shownB = await reads(b, 'b.ts', 'NebulaRouterFake')
  }
  const shownA = await reads(a, 'a.ts', 'QuasarLedgerFake')
  expect(shownB).not.toBe('')
  expect(shownA).not.toBe(shownB)
  expect(saved(files)).toMatchObject({ [shownA]: 'QuasarLedgerFake', [shownB]: 'NebulaRouterFake' })
  expect(a.state).toBe('on')
  expect(b.state).toBe('on')
})
