// Spec 085 review round 1 (correctness) #2: the git check a save makes asks
// git for .veilio only, and waits no longer than the result's own deadline.
import { expect, it, vi } from 'vitest'
import { Guard, type GuardIO } from '../../plugins/veilio-guard/lib/guard.ts'

const ROOT = '/work/project'
const MAP = `${ROOT}/.veilio/map.json`
const mapText = (map: Record<string, string>) => `${JSON.stringify({ version: 1, map }, null, 2)}\n`

function host() {
  const files: Record<string, string> = {
    [`${ROOT}/.git/HEAD`]: 'ref: refs/heads/main\n',
    [MAP]: mapText({ __CLS__1: 'QuasarLedger' }),
  }
  const calls = { listVeilio: 0, waits: [] as number[] }
  const io: GuardIO = {
    read: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`)
      return files[p]!
    },
    write: async (p, t) => void (files[p] = t),
    exists: async (p) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    realPath: async (p) => p,
    list: async () => ['README.md', 'src/pay.ts'],
    // At load nothing under .veilio is tracked; after it, a git that never answers.
    listVeilio: () =>
      ++calls.listVeilio === 1
        ? Promise.resolve([])
        : new Promise<string[] | null>(() => undefined),
    sleep: async (ms) => void calls.waits.push(ms),
  }
  return { io, files, calls }
}

it('a save that finds a changed map asks git for .veilio only, within the deadline it was given', async () => {
  const { io, files, calls } = host()
  const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await guard.load(ROOT)
  files[MAP] = mapText({ __CLS__1: 'QuasarLedger', __VAR__9: 'fakePlantedValue()' })
  const deadline = Date.now() + 1000
  await guard.afterTool(
    'Read',
    { tool: 'Read', file_path: `${ROOT}/src/pay.ts` },
    {
      result: {
        type: 'text',
        file: {
          filePath: `${ROOT}/src/pay.ts`,
          content: 'export class PaymentGatewayFake {}\n',
          numLines: 1,
          startLine: 1,
          totalLines: 1,
        },
      },
    },
    deadline
  )
  expect(calls.listVeilio).toBe(2) // load, and this save
  expect(calls.waits.at(-1)).toBeLessThanOrEqual(1000)
})

it('git is asked once for what arrived, not again on every later save', async () => {
  const { io, files, calls } = host()
  // A git that answers: nothing under .veilio is tracked.
  io.listVeilio = () => (calls.listVeilio++, Promise.resolve([]))
  const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await guard.load(ROOT)
  files[MAP] = mapText({ __CLS__1: 'QuasarLedger', __VAR__9: 'fakePlantedValue()' })
  for (const name of ['PaymentGatewayFake', 'InvoiceBuilderFake']) {
    const path = `${ROOT}/src/${name}.ts`
    await guard.afterTool(
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
      Date.now() + 1000
    )
  }
  expect(files[MAP]).toContain('InvoiceBuilderFake')
  expect(calls.listVeilio).toBe(2) // load, and the first save
})

// Review round 1 (correctness) #5: on Windows the host answers a real path
// with backslashes, and in any letter case: the store is still where it
// appears, so the guard saves.
it('on Windows, a real path with backslashes and another case is the same store', async () => {
  const W = 'C:\\work\\project'
  const files: Record<string, string> = {
    [`${W}/.git/HEAD`]: 'x',
    [`${W}/.veilio/map.json`]: mapText({}),
  }
  const io: GuardIO = {
    read: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`)
      return files[p]!
    },
    write: async (p, t) => void (files[p] = t),
    exists: async (p) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    // The root as given; a file under it in another letter case.
    realPath: async (p) =>
      p === W
        ? W
        : p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`))
          ? p.replace(/\//g, '\\').replace(/^C:\\work/, 'c:\\Work')
          : undefined,
    list: async () => ['README.md'],
    windows: async () => true,
  }
  const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await guard.load(W)
  const path = `${W}/src/pay.ts`
  await guard.afterTool(
    'Read',
    { tool: 'Read', file_path: path },
    {
      result: {
        type: 'text',
        file: {
          filePath: path,
          content: 'export class PaymentGatewayFake {}\n',
          numLines: 1,
          startLine: 1,
          totalLines: 1,
        },
      },
    },
    Date.now() + 1000
  )
  expect(guard.state).toBe('on')
  expect(files[`${W}/.veilio/map.json`]).toContain('PaymentGatewayFake')
})

// Review round 2 #2: a git that answers late leaves the question open: the
// next save asks again, and what arrived stays shown-gated meanwhile.
it('a save whose git answers late asks again at the next save, and finds the map tracked', async () => {
  const { io, files } = host()
  let asked = 0
  io.listVeilio = () =>
    ++asked === 1
      ? Promise.resolve([])
      : asked === 2
        ? new Promise<string[] | null>(() => undefined)
        : Promise.resolve(['.veilio/map.json'])
  const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await guard.load(ROOT)
  files[MAP] = mapText({ __CLS__1: 'QuasarLedger', __VAR__9: 'fakePlantedValue()' })
  const read = (name: string) => {
    const path = `${ROOT}/src/${name}.ts`
    return guard.afterTool(
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
      Date.now() + 1000
    )
  }
  await read('PaymentGatewayFake')
  expect(guard.state).toBe('on')
  const meanwhile = await guard.beforeTool({
    tool: 'Write',
    file_path: `${ROOT}/a.ts`,
    content: '__VAR__9',
  })
  expect('deny' in meanwhile && meanwhile.deny).toContain('which this session has not shown you')
  await read('InvoiceBuilderFake').catch(() => undefined)
  expect(asked).toBe(3) // load, the late save, the next save
  expect(guard.state).toBe('stopped')
  expect(guard.stoppedReason).toContain('tracked by git')
})

// Review round 3 #2, made deterministic in round 6b: vitest's fake timers
// drive both the guard's sleep and git's answer, and Date.now, so the minimum
// wait is checked by what resolves first, not by how loaded the machine is.
function timedHost(veilio: (n: number) => Promise<string[] | null>) {
  const h = host()
  let n = 0
  h.io.listVeilio = () => veilio(++n)
  h.io.sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms))
  return { ...h, asked: () => n }
}
const readNamed = (guard: Guard, name: string, deadline: number) => {
  const path = `${ROOT}/src/${name}.ts`
  return guard.afterTool(
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
    deadline
  )
}
const after = (ms: number, v: string[]) => new Promise<string[]>((r) => setTimeout(() => r(v), ms))
/** Runs `work` with every timer it sets fired in order of its due time. */
async function settled<T>(work: Promise<T>): Promise<T | undefined> {
  const done = work.catch(() => undefined)
  await vi.advanceTimersByTimeAsync(10_000)
  return done
}

it('with the deadline 2 ms away, a git that answers at 50 ms (before the 500 ms minimum) stops the guard at that save', async () => {
  vi.useFakeTimers()
  try {
    const { io, files } = timedHost((n) =>
      n === 1 ? Promise.resolve([]) : after(50, ['.veilio/map.json'])
    )
    const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
    await settled(guard.load(ROOT))
    files[MAP] = mapText({ __CLS__1: 'QuasarLedger', __VAR__9: 'fakePlantedValue()' })
    await settled(readNamed(guard, 'PaymentGatewayFake', Date.now() + 2))
    expect(guard.state).toBe('stopped')
    expect(guard.stoppedReason).toContain('tracked by git')
  } finally {
    vi.useRealTimers()
  }
})

it('with the deadline 2 ms away, a git that answers after the 500 ms minimum is asked again, and the next save stops the guard', async () => {
  vi.useFakeTimers()
  try {
    const { io, files, asked } = timedHost((n) =>
      n === 1
        ? Promise.resolve([])
        : n === 2
          ? after(600, [])
          : Promise.resolve(['.veilio/map.json'])
    )
    const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
    await settled(guard.load(ROOT))
    files[MAP] = mapText({ __CLS__1: 'QuasarLedger', __VAR__9: 'fakePlantedValue()' })
    await settled(readNamed(guard, 'PaymentGatewayFake', Date.now() + 2))
    expect(guard.state).toBe('on')
    await settled(readNamed(guard, 'InvoiceBuilderFake', Date.now() + 2000))
    expect(asked()).toBe(3)
    expect(guard.state).toBe('stopped')
  } finally {
    vi.useRealTimers()
  }
})
