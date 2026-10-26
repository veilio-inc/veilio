// An in-memory project for the plugin tests: the mods API calls the guard
// makes ($.fs.*, $.session.cwd, $.ui.log/toast, $.command.register) answered
// the way Claude Code would answer them, with every write recorded.
import { RECORDED, type Fields, type RecordedRun, type ToolRecord } from './fixtures/recorded.ts'
import type { ToolEvent } from '../lib/guard.ts'
import type { TestOn } from './kit.ts'

// Every hook test: a map grown any way but grow() throws (review of 5347c7c).
;(globalThis as { __veilioStrictMaps?: boolean }).__veilioStrictMaps = true

export const ROOT = '/work/project'
export const CANARY = 'QuasarLedgerReconciler'
export const STRIPE = 'sk_live_' + '51HbFakeFakeFake0123456789abcdefABCDEF'

export type Project = {
  files: Record<string, string>
  writes: { path: string; text: string }[]
  logs: string[]
  toasts: string[]
  /** Timers the guard asked for ($.clock.after), recorded and never fired. */
  timers: number[]
  /** Every path $.fs.read was asked for, in order. */
  reads: string[]
  /** What $.fs.stat answers as a file's mtimeMs (0 when not set). */
  mtimes: Record<string, number>
}

export type Options = {
  /** Paths that lead elsewhere, as a symbolic link does: path -> real path. */
  links?: Record<string, string>
  /** Make $.fs.write reject for a path. */
  failWrite?: (path: string) => boolean
  /** Make $.fs.read reject for a path. */
  failRead?: (path: string) => boolean
  /** Another program writes `text` to `path` just before the guard's Nth
   *  $.fs.exists of it - the moment between the guard loading and saving. */
  inject?: { path: string; beforeExistsCall: number; text: string }
  /** The organisation's managed settings, as $.settings.read({ source: 'policy' }) answers. */
  policy?: Record<string, unknown>
  /** `git ls-files` is refused, as in a project that is not a git checkout. */
  noGit?: boolean
  /** Leave $.clock to the test (mock.clock): no never-ending sleep, no
   *  recorded timers. */
  ownClock?: boolean
  /** Answer $.fs.read for a path only after this resolves: a slow disk. */
  slowRead?: (path: string) => Promise<void> | undefined
}

const abs = (p: string) => (p.startsWith('/') ? p : `${ROOT}/${p.replace(/^\.\//, '')}`)

export function project(
  on: TestOn,
  files: Record<string, string> = {},
  opts: Options = {}
): Project {
  const p: Project = {
    files: { [`${ROOT}/.git/HEAD`]: 'ref: refs/heads/main\n', ...files },
    writes: [],
    logs: [],
    toasts: [],
    timers: [],
    reads: [],
    mtimes: {},
  }
  const exists = (path: string) => {
    const a = abs(path)
    return a in p.files || Object.keys(p.files).some((f) => f.startsWith(`${a}/`))
  }
  on('session.cwd', () => ({ value: ROOT }))
  let existsCalls = 0
  on('fs.exists', (_, e) => {
    if (
      opts.inject &&
      abs(e.path) === opts.inject.path &&
      ++existsCalls === opts.inject.beforeExistsCall
    ) {
      p.files[opts.inject.path] = opts.inject.text
    }
    return { value: exists(e.path) }
  })
  on('fs.read', async (_, e) => {
    const a = abs(e.path)
    p.reads.push(a)
    await opts.slowRead?.(a)
    if (opts.failRead?.(a)) return { deny: 'EIO: the disk said no' }
    const text = p.files[a]
    return text !== undefined ? { value: text } : { deny: `ENOENT: ${a}` }
  })
  on('fs.write', (_, e) => {
    const a = abs(e.path)
    if (opts.failWrite?.(a)) return { deny: 'EACCES: read-only file system' }
    p.files[a] = e.text
    p.writes.push({ path: a, text: e.text })
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const a = abs(e.path)
    const link = opts.links?.[a] ?? opts.links?.[e.path]
    if (link) return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: true, realPath: link } }
    if (!exists(a)) return { deny: `ENOENT: ${a}` }
    return {
      value: { kind: 'file', size: 1, mtimeMs: p.mtimes[a] ?? 0, isLink: false, realPath: a },
    }
  })
  on('ui.log', (_, e) => {
    p.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    p.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'veilio' } }))
  // `git ls-files -z`, as a checkout of these files answers it: every file under
  // the root but git's own and Veilio's.
  on('process.run', (_, e) => {
    if (opts.noGit || e.argv[0] !== 'git') return { deny: 'spawn git ENOENT' }
    const tracked = Object.keys(p.files)
      .filter((f) => f.startsWith(`${ROOT}/`) && !/\/\.(git|veilio)\//.test(f))
      .map((f) => f.slice(ROOT.length + 1))
    return {
      value: {
        exitCode: 0,
        stdout: tracked.map((f) => `${f}\0`).join(''),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  // A wait that never ends: in a test the work always beats the deadline, as on
  // a fast disk. The deadline paths are tested in tests/guard/index.test.ts.
  if (!opts.ownClock) {
    on('clock.sleep', () => new Promise(() => undefined))
    on('clock.after', (_, e) => {
      p.timers.push(e.ms)
      return { value: undefined }
    })
  }
  const policy = opts.policy ?? {}
  on('settings.read', () => ({ value: policy }))
  return p
}

export function mapFile(map: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ version: 1, map, ...extra }, null, 2)}\n`
}

/** A recorded tool call: the event Claude Code fired and what it resolved to. */
export function recorded(tool: string, n = 0): { e: ToolEvent; r: RecordedRun } {
  const calls = RECORDED.filter((o) => o.kind === 'tool.call' && o.data.e.tool === tool)
  const data = calls[n]?.data
  if (!data || !isRun(data.r)) throw new Error(`no recorded ${tool} call #${n}`)
  return { e: { ...data.e, tool }, r: data.r }
}

/** A recorded tool call whose result is not a record (an error's text, an
 *  MCP tool's content blocks): what it resolved to, unread. */
export function recordedRaw(tool: string, n = 0): { e: ToolEvent; r: Fields } {
  const calls = RECORDED.filter((o) => o.kind === 'tool.call' && o.data.e.tool === tool)
  const data = calls[n]?.data
  if (!data?.r) throw new Error(`no recorded ${tool} call #${n}`)
  return { e: { ...data.e, tool }, r: data.r }
}

export function recordedPrompt(kind: string, n = 0): { e: Fields; r?: Fields } {
  const events = RECORDED.filter((o) => o.kind === kind)
  if (!events[n]) throw new Error(`no recorded ${kind} #${n}`)
  return events[n].data
}

/** The event to fire, without the keys the recording added. */
export function eventOf(rec: { e: ToolEvent }): ToolEvent {
  return { ...rec.e }
}

export function isFields(v: unknown): v is Fields {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isRun(v: unknown): v is RecordedRun {
  return isFields(v) && isFields(v.result)
}

/** What a tool call resolved to, as the tests read it: a denial, or the
 *  tool's result record and its text. */
export type Outcome = { deny?: string; result?: unknown; text?: string; isError?: boolean }

export function outcome(out: unknown): Outcome {
  if (!isFields(out)) throw new Error(`not a tool call's outcome: ${JSON.stringify(out)}`)
  const { deny, text, isError } = out
  if (deny !== undefined && typeof deny !== 'string') throw new Error('deny is not text')
  if (text !== undefined && typeof text !== 'string') throw new Error('text is not text')
  return { deny, result: out.result, text, isError: isError === true }
}

/** A tool call's result record; throws when there is none. */
export function res(out: unknown): ToolRecord {
  const result = outcome(out).result
  if (!isFields(result)) throw new Error(`no result record: ${JSON.stringify(out)}`)
  return result
}
