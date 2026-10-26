// veilio-guard: keeps the project's real identifiers and secrets away from the
// model in Claude Code (spec 033). Wiring only - the decisions are in
// ../lib/guard.ts, and contracts/mod.md lists every event handled here.
//
// Every hook that scrubs has a .catch handler that answers with a constant:
// when scrubbing throws or overruns, the result is withheld, the prompt is not
// sent, the reminder is left out. Nothing in a handler can fail.
import {
  Guard,
  PROMPT_FAILED,
  WITHHELD_FAILED,
  type GuardIO,
  type ToolEvent,
} from '../lib/guard.ts'
import { bandText, MODEL_NOTE, statusText } from '../lib/ui.ts'
import { deepRewrite } from '../lib/fields.ts'
import {
  commandRows,
  configDirOf,
  ListingCache,
  listingKind,
  parsePublicMarketplaces,
  publicEntries,
  type PublicMarketplace,
} from '../lib/listings.ts'
import type { AgentOfferInput, Host, Next, On, HookEvent } from '../lib/host.ts'

type Options = { rawOnly?: string[]; mcpRestore?: string[]; publicMarketplaces?: unknown[] }

// Spec 050 T002: session.start has the 10 s HookBudget; 6 s of it indexes the
// project. A tool result keeps 2 s of its budget for masking.
const START_MS = 6_000
const SLICE_MS = 250
const MASK_RESERVE_MS = 2_000
// Code review of d705b14: reading a listing's provenance has a deadline of
// its own, well inside the hook's budget. Past it, or on any failure, the
// listing goes fully masked; it is never left out.
const LISTING_MS = 300

function deadline<K extends HookEvent>(next: Next<K>, cap = Infinity): number {
  const left = Number(next?.budget?.remainingMs ?? 8_000) - MASK_RESERVE_MS
  return Date.now() + Math.max(0, Math.min(cap, left))
}

let guard: Guard | null = null
let loading: Promise<Guard> | null = null
let config: { rawOnly: string[]; mcpRestore: string[] } = { rawOnly: [], mcpRestore: [] }
// Guard decision 1: the offers the engine made since the last agent listing,
// each recorded once it is made: the provenance of the next listing's
// entries (lib/listings.ts). A listing round takes them and starts afresh.
const offers = new Map<string, AgentOfferInput>()
// Marketplaces the user pins as public in the plugin's own settings (never a
// project's .veilio/guard.json), each with its source; entries without one
// are ignored, and said once.
let pinned: PublicMarketplace[] = []
let ignored: string[] = []
let saidIgnored = false
// What was read of the plugin cache, by file and mtime, for the session.
const listingCache = new ListingCache()

// The public entries of a skill or agent listing, by the engine's word and
// the plugin cache, within LISTING_MS. Anything that fails or is late leaves
// none: the listing is then masked as a whole.
async function listingEntries($: Host, kind: 'skills' | 'agents'): Promise<string[]> {
  const round = kind === 'agents' ? [...offers.values()] : []
  if (kind === 'agents') offers.clear()
  if (!saidIgnored && ignored.length > 0) {
    saidIgnored = true
    $.ui.log(
      `Veilio ignored publicMarketplaces entries with no source: ${ignored.join(', ')}. ` +
        'Write each as <name>=<source>, such as acme=github:acme/plugins.'
    )
  }
  const io = {
    read: (path: string) => $.fs.read(path),
    mtime: (path: string) => $.fs.stat(path).then((s) => s.mtimeMs),
  }
  const work = (async () => {
    const [dir, home, profile, commands] = await Promise.all([
      $.env.get('CLAUDE_CONFIG_DIR'),
      $.env.get('HOME'),
      $.env.get('USERPROFILE'),
      kind === 'skills' ? $.command.list() : undefined,
    ])
    const configDir = configDirOf({ CLAUDE_CONFIG_DIR: dir, HOME: home, USERPROFILE: profile })
    const installed = await listingCache.installedInCache(io, configDir, pinned)
    const given = kind === 'skills' ? { commands: commandRows(commands) } : { offers: round }
    return publicEntries(kind, given, installed, io, listingCache)
  })().catch((): string[] => [])
  const late = $.clock.sleep(LISTING_MS).then((): string[] => [])
  return Promise.race([work, late]).catch((): string[] => [])
}

// The guard is loaded by whichever event comes first: the first prompt's
// context can arrive before session.start has finished.
async function ready($: Host): Promise<Guard> {
  if (guard) return guard
  if (!loading) {
    const io: GuardIO = {
      read: (path) => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      exists: (path) => $.fs.exists(path),
      realPath: (path) =>
        $.fs.stat(path, { resolve: true }).then(
          (s) => s.realPath,
          () => undefined
        ),
      // Spec 050: the tracked files, so the index can mask a result by what it
      // contains. Not a git checkout, or git missing: only the files a result
      // names are indexed.
      sleep: (ms) => $.clock.sleep(ms),
      list: (root) =>
        $.process.run(['git', 'ls-files', '-z'], { cwd: root }).then(
          (r) => (r.exitCode === 0 ? r.stdout.split('\0').filter(Boolean) : null),
          () => null
        ),
    }
    const g = new Guard(io, config)
    loading = $.session.cwd().then(async (cwd) => {
      await g.load(cwd)
      // The organisation's guard ignores a project's own off switch.
      if (g.state === 'off' && (await isManaged($))) g.state = 'on'
      guard = g
      return g
    })
    // A failed load fails this event closed (its .catch answers) and is tried
    // again on the next one, instead of wedging the session.
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}

// Run by the organisation: managed settings list this plugin in
// prependPlugins, so it runs before every mod a user installs, and a user's
// own settings cannot switch it off (spec 033 US3).
async function isManaged($: Host): Promise<boolean> {
  const policy: unknown = await $.settings.read({ source: 'policy' }).catch(() => ({}))
  const prepend =
    policy && typeof policy === 'object'
      ? (policy as { prependPlugins?: unknown }).prependPlugins
      : undefined
  return (
    Array.isArray(prepend) &&
    prepend.some((id) => typeof id === 'string' && id.startsWith('veilio-guard@'))
  )
}

function isTexts(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((c) => typeof c === 'string')
}

function deepDisplay(g: Guard, value: unknown): unknown {
  return deepRewrite(value, (s) => g.displayText(s))
}

export function register(on: On, options: Options = {}) {
  config = {
    rawOnly: Array.isArray(options.rawOnly) ? options.rawOnly : [],
    mcpRestore: Array.isArray(options.mcpRestore) ? options.mcpRestore : [],
  }
  ;({ pinned, ignored } = parsePublicMarketplaces(
    Array.isArray(options.publicMarketplaces) ? options.publicMarketplaces : []
  ))
  saidIgnored = false

  on('session.start', async ($, e, next) => {
    const g = await ready($)
    // Spec 050: index the project while the session starts, then in short
    // slices between calls. A timer runs outside any hook's budget, so each
    // slice stops itself after SLICE_MS to keep the mod free for tool results.
    if (g.state === 'on' && g.index) {
      // A failure turns the background index off; results are then indexed by
      // the files they name, and withheld when that fails.
      const off = (err: unknown) => {
        if (g.index) g.index.state = 'unavailable'
        if (g.index) g.index.reason = String(err instanceof Error ? err.message : err)
      }
      await g.indexProject(deadline(next, START_MS)).catch(off)
      const slice = () => {
        if (g.index?.state !== 'indexing') return
        g.indexProject(Date.now() + SLICE_MS).then(() => $.clock.after(0, slice), off)
      }
      $.clock.after(0, slice)
    }
    // The band's first draw can come before the guard has loaded, and draws
    // nothing then; without this it stayed empty until /veilio redrew it.
    $.ui.invalidate('ui.render')
    await $.command.register({
      name: 'veilio',
      description: 'Veilio guard: status, and switch it on or off for this project',
      argumentHint: '[on|off]',
      immediate: true,
    })
    return next(e)
  })

  on('tool.call', async ($, e: ToolEvent, next) => {
    const g = await ready($)
    if (g.state === 'off') return next(e)
    if (g.state === 'stopped')
      return { deny: `Veilio refused this call: ${g.stoppedReason}. Run /veilio.` }
    const before = await g.beforeTool(e)
    if ('deny' in before) {
      $.ui.log(before.deny)
      $.ui.invalidate('ui.render')
      return before
    }
    const outcome = await next(before.args)
    const after = await g.afterTool(e.tool, before.args, outcome, deadline(next))
    if ('deny' in after && after.deny.startsWith('Veilio withheld')) $.ui.log(after.deny)
    $.ui.invalidate('ui.render')
    return after
  }).catch(async () => ({ deny: WITHHELD_FAILED }))

  on('prompt.submit', async ($, e, next) => {
    const g = await ready($)
    if (g.state === 'off') return next(e)
    if (g.state === 'stopped')
      return { drop: `Veilio guard stopped: ${g.stoppedReason}. Run /veilio.` }
    // What you type is masked with every name the index knows: give it the
    // budget to reach a few more files first (spec 050).
    const state = g.index?.state
    if (state === 'new' || state === 'indexing')
      await g.indexProject(deadline(next)).catch(() => undefined)
    // A credential with its key in one is removed from the others too; each
    // text is scanned once.
    // Context the guard cannot read as text cannot be checked: the prompt is
    // not sent (code review of d705b14).
    const raw: unknown = e.context
    if (raw !== undefined && !isTexts(raw)) throw new Error('a context entry is not text')
    const given = raw ?? []
    const [scan, ...scans] = g.learnTogether([e.text, ...given])
    const text = g.applyText(e.text, 'prompt', scan)
    const context = raw !== undefined ? given.map((c, i) => g.applyContext(c, scans[i])) : undefined
    if (text !== e.text) $.ui.toast('Veilio masked names in your prompt before sending it.')
    return next({ ...e, text, ...(context ? { context } : {}) })
  }).catch(async () => ({ drop: PROMPT_FAILED }))

  on('prompt.attachment', async ($, e, next) => {
    const g = await ready($)
    const r = await next(e)
    if (g.state === 'off' || r.text === null) return r
    if (g.state === 'stopped') return { text: null }
    // Only the first message's context carries the guard's note: on 2.1.310
    // the plugins' blocks come as context_sections, and earlier builds sent
    // them with userEmail as session_context.
    const first = e.type === 'context_sections' || e.type === 'session_context'
    // Guard decision 1: a listing's public entries go as written.
    const listing = listingKind(e.type)
    const text = first
      ? g.applyContext(r.text)
      : listing
        ? g.applyListing(r.text, await listingEntries($, listing))
        : g.applyText(r.text)
    return { ...r, text }
  }).catch(async () => ({ text: null }))

  // Recorded, never changed: the provenance of the agent listing's entries.
  // Only once the engine has made the offer: one a hook beneath withdrew is
  // not recorded, and drops an earlier one of the name.
  on('agent.offer', async ($, e, next) => {
    const r = await next(e)
    if (r.isOffered === true) offers.set(e.agent, e)
    else offers.delete(e.agent)
    return r
  })

  on('prompt.context', async ($, e, next) => {
    const g = await ready($)
    const r = await next(e)
    if (g.state === 'off') return r
    if (g.state === 'stopped') return { ...r, blocks: [] }
    const raw = r.blocks.map((b) => b.text)
    const scans = g.learnTogether(raw)
    // Remembered, so the copy Claude Code passes back as an attachment is
    // not judged a second time.
    const blocks = r.blocks.map((b, i) => ({
      ...b,
      text: g.remember(g.applyText(raw[i]!, 'result', scans[i])),
    }))
    return { ...r, blocks: [...blocks, { name: 'veilioGuard', text: MODEL_NOTE }] }
  }).catch(async () => ({ blocks: [] }))

  on('skill.prompt', async ($, e, next) => {
    const g = await ready($)
    const r = await next(e)
    if (g.state === 'off') return r
    if (g.state === 'stopped') {
      return { text: `Veilio guard stopped: ${g.stoppedReason}. The skill's text was left out.` }
    }
    return { ...r, text: g.applyText(r.text) }
  }).catch(async () => ({ text: 'Veilio could not check this skill, so its text was left out.' }))

  // What the developer sees: the real names, drawn on this machine only. The
  // stored transcript keeps the placeholders.
  on('ui.render', { component: ['AssistantMessage', 'UserMessage'] }, async ($, e, next) => {
    const g = guard
    const text = e.props?.text
    if (!g || g.state !== 'on' || typeof text !== 'string') return next(e)
    return next({ ...e, props: { ...e.props, text: g.displayText(text) } })
  })

  // A row's input, and its result: an edit's diff, a command's output. Only
  // placeholders change, so the result still fits the tool's schema.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const g = guard
    if (!g || g.state !== 'on' || !e.props) return next(e)
    const props: Record<string, unknown> = { ...e.props, input: deepDisplay(g, e.props.input) }
    if (e.props.output !== undefined) props.output = deepDisplay(g, e.props.output)
    return next({ ...e, props })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const g = guard
    if (!g || g.state !== 'on' || e.props?.output === undefined) return next(e)
    return next({ ...e, props: { ...e.props, output: deepDisplay(g, e.props.output) } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const g = guard
    const below = await next(e)
    if (!g) return below
    const { Box, Text } = $.ui.resolve(e)
    const line = Text({
      dimColor: g.state === 'on',
      color: g.state === 'on' ? undefined : 'red',
      children: [bandText(g)],
    })
    return below ? Box({ flexDirection: 'column', children: [line, below] }) : line
  })

  on('command.run', { command: 'veilio' }, async ($, e) => {
    const g = await ready($)
    const managed = await isManaged($)
    const arg = String(e.args ?? '').trim()
    if (arg === 'off' && managed) {
      return {
        text: "Veilio guard is set up by your organisation's managed settings, so it can't be switched off here.",
      }
    }
    if (arg === 'off' || arg === 'on') {
      await g.setEnabled(arg === 'on')
      $.ui.invalidate('ui.render')
    }
    return { text: statusText(g, managed) }
  })
}
