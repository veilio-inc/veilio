// An in-memory project for the plugin tests: the mods API calls the guard
// makes ($.fs.*, $.session.cwd, $.ui.log/toast, $.command.register) answered
// the way Claude Code would answer them, with every write recorded.
import { RECORDED } from './fixtures/recorded.ts'

export const ROOT = '/work/project'
export const CANARY = 'QuasarLedgerReconciler'
export const STRIPE = 'sk_live_' + '51HbFakeFakeFake0123456789abcdefABCDEF'

export type Project = {
  files: Record<string, string>
  writes: { path: string; text: string }[]
  logs: string[]
  toasts: string[]
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
}

const abs = (p: string) => (p.startsWith('/') ? p : `${ROOT}/${p.replace(/^\.\//, '')}`)

export function project(on: any, files: Record<string, string> = {}, opts: Options = {}): Project {
  const p: Project = {
    files: { [`${ROOT}/.git/HEAD`]: 'ref: refs/heads/main\n', ...files },
    writes: [],
    logs: [],
    toasts: [],
  }
  const exists = (path: string) => {
    const a = abs(path)
    return a in p.files || Object.keys(p.files).some((f) => f.startsWith(`${a}/`))
  }
  on('session.cwd', () => ({ value: ROOT }))
  let existsCalls = 0
  on('fs.exists', (_: any, e: any) => {
    if (
      opts.inject &&
      abs(e.path) === opts.inject.path &&
      ++existsCalls === opts.inject.beforeExistsCall
    ) {
      p.files[opts.inject.path] = opts.inject.text
    }
    return { value: exists(e.path) }
  })
  on('fs.read', (_: any, e: any) => {
    const a = abs(e.path)
    if (opts.failRead?.(a)) return { deny: 'EIO: the disk said no' }
    return a in p.files ? { value: p.files[a] } : { deny: `ENOENT: ${a}` }
  })
  on('fs.write', (_: any, e: any) => {
    const a = abs(e.path)
    if (opts.failWrite?.(a)) return { deny: 'EACCES: read-only file system' }
    p.files[a] = e.text
    p.writes.push({ path: a, text: e.text })
    return { value: undefined }
  })
  on('fs.stat', (_: any, e: any) => {
    const a = abs(e.path)
    const link = opts.links?.[a] ?? opts.links?.[e.path]
    if (link) return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: true, realPath: link } }
    if (!exists(a)) return { deny: `ENOENT: ${a}` }
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: a } }
  })
  on('ui.log', (_: any, e: any) => {
    p.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_: any, e: any) => {
    p.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'veilio' } }))
  if (!opts.policy) on('settings.read', () => ({ value: {} }))
  else on('settings.read', () => ({ value: opts.policy }))
  return p
}

export function mapFile(map: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ version: 1, map, ...extra }, null, 2)}\n`
}

/** A recorded tool call: the event Claude Code fired and what it resolved to. */
export function recorded(tool: string, n = 0): { e: any; r: any } {
  const calls = RECORDED.filter((o) => o.kind === 'tool.call' && o.data.e.tool === tool)
  if (!calls[n]) throw new Error(`no recorded ${tool} call #${n}`)
  return calls[n].data as { e: any; r: any }
}

export function recordedPrompt(kind: string, n = 0): any {
  const events = RECORDED.filter((o) => o.kind === kind)
  if (!events[n]) throw new Error(`no recorded ${kind} #${n}`)
  return events[n].data
}

/** The event to fire, without the keys the recording added. */
export function eventOf(rec: { e: any }): any {
  return { ...rec.e }
}
