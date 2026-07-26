#!/usr/bin/env node
import { parseArgs, UsageError } from './args.js'
import {
  EXIT_ERROR,
  HELP,
  runMap,
  runRestore,
  runScan,
  runScrub,
  type Io,
} from './commands.js'

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

// Only self-invoke when run as a binary, so importing this module in tests is free.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
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
