#!/usr/bin/env node
import { parseArgs, UsageError } from './args.js'
import { EXIT_ERROR, HELP, runMap, runRestore, runScan, runScrub, type Io } from './commands.js'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const VERSION = '0.1.0'

/** Testable entry point: everything that touches the process is injected. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`veilio: ${err.message}\n\nRun "veilio --help" for usage.\n`)
      return EXIT_ERROR
    }
    throw err
  }

  try {
    switch (args.command) {
      case 'help':
        io.stdout(HELP)
        return 0
      case 'version':
        io.stdout(`${VERSION}\n`)
        return 0
      case 'scrub':
        return await runScrub(args, io)
      case 'restore':
        return await runRestore(args, io)
      case 'scan':
        return await runScan(args, io)
      case 'map':
        return await runMap(args, io)
    }
  } catch (err) {
    io.stderr(`veilio: ${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT_ERROR
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    // A TTY with no piped input would hang forever waiting for EOF. Fail with
    // usage guidance instead of appearing to freeze.
    if (process.stdin.isTTY) {
      rejectPromise(new Error('no input — pass a file or pipe to stdin'))
      return
    }
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolvePromise(data))
    process.stdin.on('error', rejectPromise)
  })
}

/**
 * Was this file run as a program, or imported?
 *
 * The obvious form of this check — comparing `import.meta.url` to
 * `file://${process.argv[1]}` — is wrong in the one way that matters, and it
 * shipped: npm installs a binary as a SYMLINK in `node_modules/.bin`, so
 * `argv[1]` is the link while `import.meta.url` is the file it resolves to. The
 * two never match, the branch below never runs, and `veilio --version` prints
 * nothing and exits 0. Installed fine, did nothing, said nothing.
 *
 * `realpathSync` resolves the link. `pathToFileURL` handles the rest of what
 * string interpolation got wrong: a path containing a space or any non-ASCII
 * character needs percent-encoding, and a Windows path needs `file:///C:/...`
 * rather than `file://C:\...`.
 *
 * Wrapped because `argv[1]` may name something unstattable — `node --eval`, or a
 * file deleted mid-run. Not a program then, which is the safe reading.
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
  const io: Io = {
    cwd: process.cwd(),
    stdin: readStdin,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }
  main(process.argv.slice(2), io).then(
    (code) => {
      process.exitCode = code
    },
    (err: unknown) => {
      process.stderr.write(`veilio: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = EXIT_ERROR
    }
  )
}
