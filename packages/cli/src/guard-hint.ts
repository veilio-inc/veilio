// Spec 070. Without veilio-guard, the CLI and the MCP server protect only what
// passes through them: an agent's own file and shell tools send code to the
// model as written (benchmark 067 run 3: 93-95 of 96 sessions). So each says so,
// on stderr, when it runs where that matters. Reads one local file; never
// writes, never calls out, never throws.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LINE_A =
  "veilio: veilio-guard is not installed. In Claude Code the CLI and MCP mask only what passes through them; the agent's own reads reach the model as written. Install it: /plugin install veilio-guard@veilio"
export const LINE_B =
  'veilio: this agent has no Veilio guard yet. Turn off its own file and shell tools so this server is the only way to your code; otherwise its reads reach the model as written.'

/**
 * Is veilio-guard recorded as installed in Claude Code's plugin record?
 * shortcut: a guard enforced only by managed settings or loaded with
 * --plugin-dir is not in this file and gets a needless hint; read those
 * sources too if people report it.
 */
export function guardInstalled(home: string = homedir()): boolean {
  try {
    const record: unknown = JSON.parse(
      readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')
    )
    const plugins = (record as { plugins?: unknown } | null)?.plugins
    if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return false
    return Object.keys(plugins).some((name) => name.startsWith('veilio-guard@'))
  } catch {
    return false
  }
}

/** The line to print, or null for none. Line B is the MCP server's alone: the CLI cannot tell it is inside another agent. */
export function guardHint(
  surface: 'cli' | 'mcp',
  env: Readonly<Record<string, string | undefined>>,
  home: string = homedir()
): string | null {
  const claude = Boolean(env.CLAUDECODE)
  if (env.CI || (surface === 'cli' && !claude)) return null
  if (guardInstalled(home)) return null
  return claude ? LINE_A : LINE_B
}
