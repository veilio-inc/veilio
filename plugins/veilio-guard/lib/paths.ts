// Files the model must never read (spec 033, FR-004).
//
// Refused before the tool runs, on the path the model wrote and on the path
// after its placeholders are restored. A project adds patterns in
// .veilio/guard.json or the plugin's settings; it cannot remove these.
//
// For shell commands this is a check on the words of the command, not a
// sandbox: `cat .env` is refused, a script that opens .env is not. The
// coverage statement says so; strict mode (a later spec) is the answer to it.

// The list and its matcher live in the engine (spec 078 FR-016), shared with
// the MCP server.
export { DEFAULT_RAW_ONLY, isRawOnly } from '../vendor/engine/index.js'

/** The words of a shell command that could name a file: unquoted, split on
 *  whitespace, shell operators, braces and commas, and each piece around `=`
 *  and `:` checked too: a flag's or assignment's value (`--env-file=.env`,
 *  `FOO=.env`, PowerShell's `-Path:.env`) and an NTFS stream (`.env::$DATA`).
 *  Braces and commas cover a PowerShell script block and argument list
 *  (`{gc .env}`, `gc a,.env`). Flags themselves are dropped.
 *
 *  A check on the words as written, not a shell: quoting inside a word,
 *  escapes, brace expansion and wildcards are not expanded (COVERAGE.md). */
export function pathsInCommand(command: string): string[] {
  const words = new Set<string>()
  const add = (w: string) => {
    const word = w.replace(/^['"]+|['"]+$/g, '')
    if (word !== '' && !word.startsWith('-')) words.add(word)
  }
  for (const token of command.split(/[\s|&;<>()`$,{}]+/)) {
    add(token)
    for (const piece of token.split(/[=:]+/)) add(piece)
  }
  return [...words]
}
