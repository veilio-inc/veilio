#!/usr/bin/env node
// stdio transport wiring.
//
// stdout carries the JSON-RPC stream and nothing else — a stray console.log
// here corrupts the protocol and the client drops the connection. Diagnostics
// go to stderr, which MCP clients surface as server logs.

import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { guardHint } from '@veilio-inc/cli/guard-hint'
import { pathToFileURL } from 'node:url'
import { FrameReader, type JsonRpcResponse } from './server.js'
import type { ToolContext } from './tools.js'
import { primeNamespace } from './namespace.js'
import { primeRules } from './rules.js'
import { SIGN_IN_POLL_MS, SignInWatcher, TOOLS_LIST_CHANGED } from './sign-in-watch.js'

export { FrameReader, handleFrame, handleMessage, SERVER_VERSION } from './server.js'
export { TOOLS, CLOUD_TOOLS, callTool, callToolAsync, listTools } from './tools.js'

/**
 * The server's context from its arguments and environment.
 *
 * `destructive` is read from VEILIO_MCP_DESTRUCTIVE here, once, at start, and
 * only an exact "1" turns it on: it is the person's decision, made where they
 * configure the server, and nothing a tool call carries can change it
 * (spec 052 FR-010).
 *
 * Nor can the project (spec 093 item 8): a repository's own configuration
 * files set the environment of the servers they declare, so when one of them
 * (`projectSetsSwitch`) - from the folder the server was started in, or from
 * its `--root` - names either switch, both are off and `switchesIgnored` says
 * so.
 */
export function contextFromArgv(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  startedIn: string = process.cwd()
): ToolContext {
  const cli = parseCliContext(argv, startedIn)
  const naming = projectSetsSwitch(startedIn) ?? projectSetsSwitch(cli.cwd)
  const ignored = naming !== null
  return {
    ...cli,
    destructive: !ignored && env.VEILIO_MCP_DESTRUCTIVE === '1',
    // Spec 078 FR-018: the same pattern, read once here.
    restoreText: !ignored && env.VEILIO_MCP_RESTORE === '1',
    env,
    ...(naming !== null ? { switchesIgnored: switchesIgnored(naming) } : {}),
  }
}

/** Said on stderr when the two switches are ignored. `file`: one of
 *  PROJECT_FILES, never text from the project. */
const switchesIgnored = (file: string): string =>
  `veilio-mcp: a configuration file in this project (${file}) sets VEILIO_MCP_RESTORE / VEILIO_MCP_DESTRUCTIVE, or could not be read as JSON. These two settings are ignored; set them in your own environment, outside the project, to use them.`

// The files in a project that can start this server or set its environment:
// Claude Code's, Cursor's and VS Code's.
const PROJECT_FILES = [
  '.mcp.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
]
const SWITCH_NAMED = /VEILIO_MCP_(?:RESTORE|DESTRUCTIVE)/i
const READ_CAP = 1024 * 1024

/**
 * The project file that names either switch, or null: in `dir` or a folder
 * above it, up to the one that holds `.git` (the project's root). Read as
 * text, so an `env` key, the arguments of a wrapper command (`env NAME=1 ...`)
 * and another letter case all count - and read again as the JSON a client
 * decodes, where a name may be written with escapes (`\u0052`). A file that
 * is not JSON (comments, a trailing comma, a broken file) cannot be read the
 * way its client reads it, and counts as naming one. The home folder and
 * above are not read: the files there are the person's own, where the switch
 * is theirs to set. A file that is missing or unreadable names none; one too
 * large to read whole counts as naming one, since what follows the cap was
 * not seen. A wrapper command that builds the name at run time is not found.
 */
function projectSetsSwitch(dir: string): string | null {
  const home = resolve(homedir())
  for (let at = resolve(dir); at !== home; at = dirname(at)) {
    const file = PROJECT_FILES.find((name) => namesSwitch(join(at, name)))
    if (file !== undefined) return file
    if (existsSync(join(at, '.git')) || dirname(at) === at) break
  }
  return null
}

function namesSwitch(file: string): boolean {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return false
  }
  try {
    const text = Buffer.alloc(READ_CAP + 1)
    const read = readSync(fd, text, 0, text.length, 0)
    if (read > READ_CAP || SWITCH_NAMED.test(text.toString('latin1', 0, read))) return true
    return namedDecoded(text.toString('utf8', 0, read))
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/** Whether the JSON `text` names a switch once its escapes are decoded; text
 *  that is not JSON is taken to. */
function namedDecoded(text: string): boolean {
  try {
    return SWITCH_NAMED.test(JSON.stringify(JSON.parse(text)))
  } catch {
    return true
  }
}

function parseCliContext(argv: readonly string[], startedIn: string): ToolContext {
  let cwd = startedIn
  let mapPath: string | null = null
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--root' || argv[i] === '-r') && argv[i + 1] !== undefined) {
      cwd = argv[++i]
    } else if ((argv[i] === '--map' || argv[i] === '-m') && argv[i + 1] !== undefined) {
      mapPath = argv[++i]
    }
  }
  return { cwd, mapPath }
}

async function start(): Promise<void> {
  const ctx = contextFromArgv(process.argv.slice(2))
  ctx.guardHint = guardHint('mcp', process.env)
  if (ctx.guardHint) process.stderr.write(`${ctx.guardHint}\n`)
  if (ctx.switchesIgnored) process.stderr.write(`${ctx.switchesIgnored}\n`)
  if (ctx.restoreText)
    process.stderr.write(
      "veilio: restore_text is on (VEILIO_MCP_RESTORE=1). Its answers put the real names into the agent's context.\n"
    )
  const send = (response: JsonRpcResponse): void => {
    process.stdout.write(`${JSON.stringify(response)}\n`)
  }
  const reader = new FrameReader(ctx, send)

  // Resolved once, before a single byte of stdin is read, so every tool call
  // for the rest of this process sees the answer already settled rather than
  // racing the first one in (contracts/shared-namespace.md R-007). Never
  // throws — see namespace.ts — so this can only delay startup, not fail it.
  await Promise.all([primeNamespace(undefined, { env: ctx.env }), primeRules()])

  // Signing in or out while this runs changes the tool list; say so.
  const watcher = new SignInWatcher(ctx.home, () =>
    process.stdout.write(`${JSON.stringify(TOOLS_LIST_CHANGED)}\n`)
  )
  setInterval(() => watcher.check(), SIGN_IN_POLL_MS).unref()

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => reader.push(chunk))
  process.stdin.on('end', () => {
    void reader.drain().then(() => process.exit(0))
  })
  process.stderr.write(`veilio-mcp: serving ${ctx.cwd}\n`)
}

/**
 * Was this file run as a program, or imported?
 *
 * Comparing `import.meta.url` to `file://${process.argv[1]}` is wrong, and it
 * shipped here as it once did in the CLI: npx and npm run a binary through a
 * SYMLINK in node_modules/.bin, so `argv[1]` is the link while
 * `import.meta.url` is the file it resolves to. A path with a space, and every
 * Windows path (`C:\...` against `file:///C:/...`), fail the same way. The
 * server then exited 0 having said nothing, and the agent saw a server that
 * never answered.
 *
 * `realpathSync` resolves the link; `pathToFileURL` builds the URL the way
 * Node does. Wrapped because `argv[1]` may name something unstattable
 * (`node --eval`), which is not a program.
 */
function invokedAsProgram(): boolean {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href
  } catch {
    return false
  }
}

if (invokedAsProgram()) {
  void start()
}
