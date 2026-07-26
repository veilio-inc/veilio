// Hand-rolled argument parsing. The engine ships zero runtime dependencies as a
// privacy invariant (an audited supply chain is the point), and a CLI that
// wraps it should not undo that for the sake of flag parsing.

import { LANGUAGES, type Language, type LanguageOption } from '@veilio/shared'
import type { SecretPolicy } from '@veilio/shared'

export type Command = 'scrub' | 'restore' | 'scan' | 'map' | 'help' | 'version'

export interface ParsedArgs {
  command: Command
  /** Positional file paths. Empty means read stdin (or, for `scan`, error). */
  files: string[]
  language: LanguageOption
  secrets: SecretPolicy
  /** Prepend the downstream-AI preamble and legend to scrub output. */
  preamble: boolean
  /** Override the map store location. */
  mapPath: string | null
  /** Machine-readable output (scan). */
  json: boolean
  /** Suppress the human-readable summary on stderr. */
  quiet: boolean
  /** `map --clear` wipes the store. */
  clear: boolean
  /** Treat medium-severity findings as failures too (scan). */
  strict: boolean
}

export class UsageError extends Error {}

const COMMANDS = new Set<Command>(['scrub', 'restore', 'scan', 'map', 'help', 'version'])
const SECRET_POLICIES = new Set<SecretPolicy>(['redact', 'warn', 'off'])
const LANGUAGE_VALUES = new Set<string>([...LANGUAGES, 'auto'])

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('-')) {
    throw new UsageError(`${flag} requires a value`)
  }
  return value
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: 'help',
    files: [],
    language: 'auto',
    secrets: 'redact',
    preamble: false,
    mapPath: null,
    json: false,
    quiet: false,
    clear: false,
    strict: false,
  }

  if (argv.length === 0) return parsed

  let i = 0
  const first = argv[0]
  if (!first.startsWith('-')) {
    if (!COMMANDS.has(first as Command)) {
      throw new UsageError(`unknown command "${first}"`)
    }
    parsed.command = first as Command
    i = 1
  }

  for (; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        parsed.command = 'help'
        break
      case '-v':
      case '--version':
        parsed.command = 'version'
        break
      case '-l':
      case '--language': {
        const value = requireValue(arg, argv[++i])
        if (!LANGUAGE_VALUES.has(value)) {
          throw new UsageError(
            `unknown language "${value}" — expected auto or one of: ${LANGUAGES.join(', ')}`
          )
        }
        parsed.language = value as Language | 'auto'
        break
      }
      case '-s':
      case '--secrets': {
        const value = requireValue(arg, argv[++i])
        if (!SECRET_POLICIES.has(value as SecretPolicy)) {
          throw new UsageError(`--secrets must be redact, warn, or off (got "${value}")`)
        }
        parsed.secrets = value as SecretPolicy
        break
      }
      case '-m':
      case '--map':
        parsed.mapPath = requireValue(arg, argv[++i])
        break
      case '-p':
      case '--preamble':
        parsed.preamble = true
        break
      case '--json':
        parsed.json = true
        break
      case '-q':
      case '--quiet':
        parsed.quiet = true
        break
      case '--clear':
        parsed.clear = true
        break
      case '--strict':
        parsed.strict = true
        break
      default:
        if (arg.startsWith('-') && arg !== '-') {
          throw new UsageError(`unknown flag "${arg}"`)
        }
        parsed.files.push(arg)
    }
  }

  return parsed
}
