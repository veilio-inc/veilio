// Hand-rolled argument parsing. The engine ships zero runtime dependencies as a
// privacy invariant (an audited supply chain is the point), and a CLI that
// wraps it should not undo that for the sake of flag parsing.

import { LANGUAGES, type Language, type LanguageOption } from '@veilio-inc/engine'
import type { SecretPolicy } from '@veilio-inc/engine'

export type Command =
  | 'scrub'
  | 'restore'
  | 'scan'
  | 'map'
  | 'login'
  | 'logout'
  | 'whoami'
  | 'maps'
  | 'help'
  | 'version'

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
  /** Keep JSDoc blocks when restoring. */
  keepDocs: boolean
  /** Allow a map write that would drop entries already on disk. */
  force: boolean
  /**
   * `maps` subcommand: list, pull or push. Null when `maps` was given alone.
   *
   * A subcommand rather than three top-level commands, because `map` (singular,
   * the local store) already exists and `veilio push` next to `veilio map`
   * reads like they are the same thing. `maps <verb>` keeps the cloud surface
   * visibly separate from the offline one.
   */
  mapsAction: 'list' | 'pull' | 'push' | null

  /**
   * Base URL of the Veilio instance to sign in to. Null means the public Cloud.
   *
   * Only meaningful to `login`: once signed in, the instance is read back from
   * the stored credential, so a later command cannot be pointed at a different
   * host while still holding the first one's token.
   */
  instance: string | null
}

export class UsageError extends Error {}

const COMMANDS = new Set<Command>([
  'scrub',
  'restore',
  'scan',
  'map',
  'login',
  'logout',
  'whoami',
  'maps',
  'help',
  'version',
])

/**
 * The commands that reach the network. Named here so the split is one list
 * rather than a condition repeated at each call site — and so that adding a
 * command without deciding which side of the line it falls on is a compile
 * error rather than an accident.
 */
export const CLOUD_COMMANDS = new Set<Command>(['login', 'logout', 'whoami', 'maps'])
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
    keepDocs: false,
    force: false,
    instance: null,
    mapsAction: null,
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

    // `maps` takes a verb. Read here rather than as a positional later, so that
    // `veilio maps pull abc` does not treat `pull` as a file to anonymize.
    if (parsed.command === 'maps') {
      const verb = argv[1]
      if (verb !== undefined && !verb.startsWith('-')) {
        if (verb !== 'list' && verb !== 'pull' && verb !== 'push') {
          throw new UsageError(`unknown maps action "${verb}" — expected list, pull or push`)
        }
        parsed.mapsAction = verb
        i = 2
      }
    }
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
      case '--keep-docs':
        parsed.keepDocs = true
        break
      case '-f':
      case '--force':
        parsed.force = true
        break
      case '--instance': {
        const value = requireValue(arg, argv[++i])
        // Parsed here rather than at use, so a typo is a usage error before any
        // password is typed rather than a confusing failure after.
        let url: URL
        try {
          url = new URL(value)
        } catch {
          throw new UsageError(`--instance must be a URL (got "${value}")`)
        }
        if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
          throw new UsageError(
            `--instance must be https (got "${value}") — a password and a session token over ` +
              'plain http are readable by anything on the path. localhost is allowed for development.'
          )
        }
        parsed.instance = value
        break
      }
      default:
        if (arg.startsWith('-') && arg !== '-') {
          throw new UsageError(`unknown flag "${arg}"`)
        }
        parsed.files.push(arg)
    }
  }

  return parsed
}
