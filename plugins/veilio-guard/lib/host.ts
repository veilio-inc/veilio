// The part of Claude Code's mod API the guard uses, as types.
//
// Claude Code writes its full API as the `claude-code` module beside a loaded
// mod (.claude-plugin/types, ignored by git), so CI cannot import it. These
// declarations follow it (2.1.310, with the 2.1.288 subset CI tests on) for
// what hooks/register.ts calls and reads, and nothing more. A field the guard
// does not rely on is left out; one whose shape it cannot rely on is
// `unknown`, narrowed where it is read.
import type { ToolEvent } from './guard.ts'

/** `$`: the engine, as the guard's hooks reach it. */
export interface Host {
  readonly fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    exists(path: string): Promise<boolean>
    stat(path: string, options?: { resolve?: boolean }): Promise<{ realPath?: string }>
  }
  readonly clock: {
    sleep(ms: number): Promise<void>
    after(ms: number, fn: () => void): unknown
  }
  readonly process: {
    run(
      argv: readonly string[],
      init?: { cwd?: string }
    ): Promise<{ exitCode: number; stdout: string; stderr?: string }>
  }
  readonly session: { cwd(): Promise<string> }
  readonly settings: { read(args: { source: 'policy' }): Promise<unknown> }
  readonly env: { get(name: string): Promise<string | undefined> }
  readonly command: {
    /** The slash commands, skills among them: read as unknown, narrowed by
     *  lib/listings.ts. */
    list(): Promise<unknown>
    register(spec: {
      name: string
      description: string
      argumentHint?: string
      immediate?: boolean
    }): Promise<unknown>
  }
  readonly ui: {
    invalidate(event: 'ui.render'): void
    log(text: string): void
    toast(text: string): void
    resolve(e: RenderInput): RenderTable
  }
}

/** The elements a `ui.render` hook draws with, from the surface's table. */
export type RenderTable = {
  Box(props: { flexDirection?: 'row' | 'column'; children: unknown[] }): unknown
  Text(props: { dimColor?: boolean; color?: string; children: unknown[] }): unknown
}

export type SessionStartInput = { readonly cwd: string }
export type SessionStartResult = { readonly cwd: string }

/** What a tool call resolved to, as the guard's afterTool takes it. */
export type ToolCallResult = {
  deny?: string
  result?: unknown
  text?: string
  isError?: boolean
}

export type PromptSubmitInput = {
  readonly text: string
  readonly context?: readonly string[]
  readonly [key: string]: unknown
}
export type PromptSubmitResult = { readonly drop?: string; readonly [key: string]: unknown }

export type PromptAttachmentInput = {
  readonly type: string
  readonly text: string
  readonly origin?: unknown
  readonly agentId?: string
  readonly detail?: unknown
}
export type PromptAttachmentResult = { readonly text: string | null }

export type ContextBlock = { readonly name: string; readonly text: string }
export type PromptContextInput = {
  readonly blocks: readonly ContextBlock[]
  readonly [key: string]: unknown
}
export type PromptContextResult = {
  readonly blocks: readonly ContextBlock[]
  readonly [key: string]: unknown
}

export type SkillPromptInput = {
  readonly skill: string
  readonly text: string
  readonly [key: string]: unknown
}
export type SkillPromptResult = { readonly text: string }

/** Who provides an agent type: `{ plugin: 'engine', tier: 'core' }` for a
 *  built-in, `<name>@<marketplace>` for a plugin's. */
export type AgentProvider = { readonly plugin: string; readonly tier: string }
export type AgentOfferInput = {
  readonly agent: string
  readonly description: string
  readonly source: string
  readonly provider: AgentProvider
}
export type AgentOfferResult = { readonly isOffered: boolean }

export type RenderInput = {
  readonly component: string
  readonly surface?: string
  readonly props?: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}
/** A drawn tree, or nothing: the guard passes others' trees on unread. */
export type RenderResult = unknown

export type CommandRunInput = { readonly command: string; readonly args?: string }
export type CommandRunResult = { readonly text: string }

/** Each event the guard hooks: what the hook is given and what it answers. */
export interface HookEvents {
  'session.start': { input: SessionStartInput; result: SessionStartResult }
  'tool.call': { input: ToolEvent; result: ToolCallResult }
  'prompt.submit': { input: PromptSubmitInput; result: PromptSubmitResult }
  'prompt.attachment': { input: PromptAttachmentInput; result: PromptAttachmentResult }
  'prompt.context': { input: PromptContextInput; result: PromptContextResult }
  'skill.prompt': { input: SkillPromptInput; result: SkillPromptResult }
  'agent.offer': { input: AgentOfferInput; result: AgentOfferResult }
  'ui.render': { input: RenderInput; result: RenderResult }
  'command.run': { input: CommandRunInput; result: CommandRunResult }
}
export type HookEvent = keyof HookEvents
export type InputOf<K extends HookEvent> = HookEvents[K]['input']
export type ResultOf<K extends HookEvent> = HookEvents[K]['result']

/** `next`: the hooks beneath and the engine's own behaviour, with the time
 *  left in this hook's budget. */
export type Next<K extends HookEvent> = ((e: InputOf<K>) => Promise<ResultOf<K>>) & {
  readonly budget?: { readonly remainingMs?: number }
  readonly called?: boolean
}

export type HookFn<K extends HookEvent> = (
  $: Host,
  e: InputOf<K>,
  next: Next<K>
) => Promise<ResultOf<K>>

/** What `on` hands back: a handler for when the hook throws or overruns. */
export type Registration<K extends HookEvent> = {
  readonly catch: (handler: HookFn<K>) => void
}

export type Matcher = Readonly<Record<string, string | readonly string[]>>

export interface On {
  <K extends HookEvent>(event: K, hook: HookFn<K>): Registration<K>
  <K extends HookEvent>(event: K, matcher: Matcher, hook: HookFn<K>): Registration<K>
}
