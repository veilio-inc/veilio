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

type Options = { rawOnly?: string[]; mcpRestore?: string[] }

let guard: Guard | null = null
let loading: Promise<Guard> | null = null
let config: { rawOnly: string[]; mcpRestore: string[] } = { rawOnly: [], mcpRestore: [] }

// The guard is loaded by whichever event comes first: the first prompt's
// context can arrive before session.start has finished.
async function ready($: any): Promise<Guard> {
  if (guard) return guard
  if (!loading) {
    const io: GuardIO = {
      read: (path) => $.fs.read(path) as Promise<string>,
      write: (path, text) => $.fs.write(path, text),
      exists: (path) => $.fs.exists(path),
      realPath: (path) =>
        $.fs.stat(path, { resolve: true }).then(
          (s: { realPath?: string }) => s.realPath,
          () => undefined
        ),
    }
    const g = new Guard(io, config)
    loading = $.session.cwd().then(async (cwd: string) => {
      await g.load(cwd)
      // The organisation's guard ignores a project's own off switch.
      if (g.state === 'off' && (await isManaged($))) g.state = 'on'
      guard = g
      return g
    })
    // A failed load fails this event closed (its .catch answers) and is tried
    // again on the next one, instead of wedging the session.
    loading!.catch(() => {
      loading = null
    })
  }
  return loading as Promise<Guard>
}

// Run by the organisation: managed settings list this plugin in
// prependPlugins, so it runs before every mod a user installs, and a user's
// own settings cannot switch it off (spec 033 US3).
async function isManaged($: any): Promise<boolean> {
  const policy = await $.settings.read({ source: 'policy' }).catch(() => ({}))
  const prepend = (policy as { prependPlugins?: unknown }).prependPlugins
  return (
    Array.isArray(prepend) &&
    prepend.some((id) => typeof id === 'string' && id.startsWith('veilio-guard@'))
  )
}

function deepDisplay(g: Guard, value: unknown): unknown {
  return deepRewrite(value, (s) => g.displayText(s))
}

export function register(on: any, options: Options = {}) {
  config = {
    rawOnly: Array.isArray(options.rawOnly) ? options.rawOnly : [],
    mcpRestore: Array.isArray(options.mcpRestore) ? options.mcpRestore : [],
  }

  on('session.start', async ($: any, e: any, next: any) => {
    await ready($)
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

  on('tool.call', async ($: any, e: ToolEvent, next: any) => {
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
    const after = await g.afterTool(e.tool, before.args, outcome)
    if ('deny' in after && after.deny.startsWith('Veilio withheld')) $.ui.log(after.deny)
    $.ui.invalidate('ui.render')
    return after
  }).catch(async () => ({ deny: WITHHELD_FAILED }))

  on('prompt.submit', async ($: any, e: any, next: any) => {
    const g = await ready($)
    if (g.state === 'off') return next(e)
    if (g.state === 'stopped')
      return { drop: `Veilio guard stopped: ${g.stoppedReason}. Run /veilio.` }
    const text = g.applyText(e.text)
    const context = Array.isArray(e.context)
      ? e.context.map((c: string) => g.applyText(c))
      : undefined
    if (text !== e.text) $.ui.toast('Veilio masked names in your prompt before sending it.')
    return next({ ...e, text, ...(context ? { context } : {}) })
  }).catch(async () => ({ drop: PROMPT_FAILED }))

  on('prompt.attachment', async ($: any, e: any, next: any) => {
    const g = await ready($)
    const r = await next(e)
    if (g.state === 'off' || r.text === null) return r
    if (g.state === 'stopped') return { text: null }
    return { ...r, text: g.applyText(r.text) }
  }).catch(async () => ({ text: null }))

  on('prompt.context', async ($: any, e: any, next: any) => {
    const g = await ready($)
    const r = await next(e)
    if (g.state === 'off') return r
    if (g.state === 'stopped') return { ...r, blocks: [] }
    const blocks = r.blocks.map((b: { text: string }) => ({ ...b, text: g.applyText(b.text) }))
    return { ...r, blocks: [...blocks, { name: 'veilioGuard', text: MODEL_NOTE }] }
  }).catch(async () => ({ blocks: [] }))

  on('skill.prompt', async ($: any, e: any, next: any) => {
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
  on(
    'ui.render',
    { component: ['AssistantMessage', 'UserMessage'] },
    async ($: any, e: any, next: any) => {
      const g = guard
      if (!g || g.state !== 'on' || typeof e.props?.text !== 'string') return next(e)
      return next({ ...e, props: { ...e.props, text: g.displayText(e.props.text) } })
    }
  )

  // A row's input, and its result: an edit's diff, a command's output. Only
  // placeholders change, so the result still fits the tool's schema.
  on('ui.render', { component: 'ToolUse' }, async ($: any, e: any, next: any) => {
    const g = guard
    if (!g || g.state !== 'on' || !e.props) return next(e)
    const props = { ...e.props, input: deepDisplay(g, e.props.input) }
    if (e.props.output !== undefined) props.output = deepDisplay(g, e.props.output)
    return next({ ...e, props })
  })

  on('ui.render', { component: 'ToolResult' }, async ($: any, e: any, next: any) => {
    const g = guard
    if (!g || g.state !== 'on' || e.props?.output === undefined) return next(e)
    return next({ ...e, props: { ...e.props, output: deepDisplay(g, e.props.output) } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: any) => {
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

  on('command.run', { command: 'veilio' }, async ($: any, e: any) => {
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
