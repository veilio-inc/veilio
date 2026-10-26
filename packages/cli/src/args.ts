// Hand-rolled argument parsing. The engine ships zero runtime dependencies as a
// privacy invariant (an audited supply chain is the point), and a CLI that
// wraps it should not undo that for the sake of flag parsing.

import { LANGUAGES, type Language, type LanguageOption } from '@veilio-inc/engine'
import type { SecretPolicy } from '@veilio-inc/engine'
import {
  COMMAND_SPECS,
  COMMAND_WORDS,
  actionList,
  actionsOf,
  belongsTo,
  flagFor,
  flagsOf,
  runsBare,
  spell,
  type ActionOf,
  type CommandKey,
  type CommandWord,
} from './flags.js'

/** A top-level command word (from the command table), or what a flag asks
 *  for when no command does work: `help` or `version`. */
export type Command = CommandWord | 'help' | 'version'

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
   * `login --device`: sign in through a browser instead of typing a password.
   *
   * The right choice for an account bound by a team's SSO requirement: a
   * password typed here is accepted by the login route and then refused by
   * every later request, which reads as a broken tool rather than as the wrong
   * way in. Automatic anyway when the instance requires a CAPTCHA.
   */
  device: boolean
  /**
   * `maps push --team`: publish to the team instead of to this account.
   *
   * A flag rather than a separate verb because it is the same act with a
   * different audience, and because `maps push` already means "upload the
   * local map" — a `maps publish` beside it would read as a different
   * operation on a different thing.
   */
  team: boolean
  /**
   * `maps` subcommand: list, pull or push. Null when `maps` was given alone.
   *
   * A subcommand rather than three top-level commands, because `map` (singular,
   * the local store) already exists and `veilio push` next to `veilio map`
   * reads like they are the same thing. `maps <verb>` keeps the cloud surface
   * visibly separate from the offline one.
   */
  mapsAction: ActionOf<'maps'> | null
  /**
   * `maps update --allow-drop`: let an update remove entries the Cloud map
   * holds and the local map does not (spec 052 FR-005). Its own flag rather
   * than `--force`, which already means "overwrite the LOCAL map" on a pull:
   * one word for two opposite directions is how somebody loses the wrong copy.
   */
  allowDrop: boolean

  /**
   * `team unlock` / `team lock`.
   *
   * A subcommand for the same reason `maps` is one: `veilio unlock` alone would
   * not say what it unlocks, and what it unlocks is specifically the team's
   * keys rather than the account or the local store.
   */
  teamAction: ActionOf<'team'> | null
  /**
   * `vault unlock` / `vault lock` (spec 052): the personal-maps key, kept on
   * this machine so personal maps open without a passphrase - for the MCP
   * server above all. `vault`, not `team`: it is the account's own key.
   */
  vaultAction: ActionOf<'vault'> | null
  /** `vault unlock --days N`, `team unlock --days N`: how long the unlock
   *  lasts. Null: the default, 7 days. */
  days: number | null
  /** `projects` (or `projects list`) and `projects use <name|id>`. */
  projectsAction: ActionOf<'projects'> | null
  /** `rules pull`. */
  rulesAction: ActionOf<'rules'> | null

  /**
   * Base URL of the Veilio instance to sign in to. Null means the public Cloud.
   *
   * Only meaningful to `login`: once signed in, the instance is read back from
   * the stored credential, so a later command cannot be pointed at a different
   * host while still holding the first one's token.
   */
  instance: string | null

  /**
   * What `--help` was asked about: a command key (`maps pull`), a group with no
   * action (`maps`), or null for the general help. Set only when `command` is
   * `help`.
   */
  helpTopic: string | null
}

export class UsageError extends Error {
  /** The command the error is about, when there is one: the CLI then prints
   *  `veilio scrub: …` rather than `veilio: …`. */
  readonly command: string | undefined
  /** Print the general help with the error: a line of flags and no command. */
  readonly showHelp: boolean

  constructor(message: string, command?: string, showHelp = false) {
    super(message)
    this.command = command
    this.showHelp = showHelp
  }
}

/** The one wording for a flag a command does not take, known or not: it
 *  names the command and lists the options it does take. */
function refusedFlag(spelling: string, command: CommandKey, known: boolean): UsageError {
  const options = flagsOf(command)
  const what = known
    ? `${spelling} is not an option for ${command}.`
    : `unknown option ${spelling}.`
  return new UsageError(
    `${what} Options for ${command}: ${options.map(spell).join(', ')}.`,
    command
  )
}

const COMMANDS = new Set<string>(COMMAND_WORDS)

/** Where each group keeps its action in ParsedArgs. */
const ACTION_FIELD = {
  maps: 'mapsAction',
  team: 'teamAction',
  vault: 'vaultAction',
  projects: 'projectsAction',
  rules: 'rulesAction',
} as const satisfies Record<string, keyof ParsedArgs>

/**
 * The commands that reach the network, from the command table. Adding a
 * command to the table means deciding which side of the line it is on.
 */
export const CLOUD_COMMANDS = new Set<Command>(
  COMMAND_SPECS.filter((c) => c.cloud).map((c) => c.key.split(' ')[0] as Command)
)

/** `maps needs an action — list, pull, push, update or rm.` */
export function needsAction(word: string): string {
  return `${word} needs an action — ${actionList(word)}.`
}

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
    team: false,
    device: false,
    instance: null,
    mapsAction: null,
    allowDrop: false,
    teamAction: null,
    vaultAction: null,
    projectsAction: null,
    days: null,
    rulesAction: null,
    helpTopic: null,
  }

  if (argv.length === 0) return parsed

  // The command is the first word that is neither a flag nor a flag's value,
  // wherever it sits: `veilio -q scrub a.ts` and `veilio --json scan x` are
  // read as `scrub -q a.ts` and `scan --json x`, and checked the same way.
  const taken = new Set<number>()
  let commandAt = -1
  for (let j = 0; j < argv.length; j++) {
    const arg = argv[j]
    if (arg.startsWith('-') && arg !== '-') {
      if (flagFor(arg)?.value !== undefined) j++
      continue
    }
    commandAt = j
    break
  }

  const wantsHelp = argv.some((a) => a === '--help' || a === '-h')
  const word = commandAt === -1 ? null : argv[commandAt]

  // `--help` anywhere on the line wins, before anything else can refuse it:
  // `veilio scrub --days 3 -h` shows scrub's help, not an error.
  if (wantsHelp) {
    parsed.command = 'help'
    if (word !== null && COMMANDS.has(word)) {
      const verb = argv[commandAt + 1]
      parsed.helpTopic =
        verb !== undefined && actionsOf(word).includes(verb) ? `${word} ${verb}` : word
    }
    return parsed
  }

  let key: CommandKey | null = null
  if (word !== null) {
    if (!COMMANDS.has(word)) throw new UsageError(`unknown command "${word}"`)
    parsed.command = word as Command
    taken.add(commandAt)

    // A group takes a verb. Read here rather than as a positional later, so
    // that `veilio maps pull abc` does not treat `pull` as a file.
    const actions = actionsOf(word)
    if (actions.length > 0) {
      const verb = argv[commandAt + 1]
      if (verb !== undefined && !verb.startsWith('-')) {
        if (!actions.includes(verb)) {
          throw new UsageError(`unknown ${word} action "${verb}" — expected ${actionList(word)}`)
        }
        const field = ACTION_FIELD[word as keyof typeof ACTION_FIELD]
        ;(parsed as unknown as Record<string, unknown>)[field] = verb
        taken.add(commandAt + 1)
        key = `${word} ${verb}` as CommandKey
      } else if (runsBare(word)) {
        key = word as CommandKey
      } else {
        // `veilio maps` alone has nothing to run, whatever flags follow.
        throw new UsageError(needsAction(word))
      }
    } else {
      key = word as CommandKey
    }
  }

  // A line of flags and no command. --help and --version answer on their
  // own; any other known flag has no command to belong to.
  let commandless: string | null = null

  for (let i = 0; i < argv.length; i++) {
    if (taken.has(i)) continue
    const arg = argv[i]
    if (arg.startsWith('-') && arg !== '-') {
      const flag = flagFor(arg)
      if (key !== null && !flag) {
        throw refusedFlag(arg, key, false)
      } else if (key !== null && flag && !belongsTo(flag, key)) {
        // A flag that exists but is not this command's is refused, not
        // ignored. `veilio scrub --days 3` used to run with `--days` doing
        // nothing.
        throw refusedFlag(arg, key, true)
      } else if (key === null && flag && flag.commands !== 'all') {
        commandless ??= arg
      }
    }
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
      case '--team':
        parsed.team = true
        break
      case '--device':
        parsed.device = true
        break
      case '-f':
      case '--force':
        parsed.force = true
        break
      case '--days': {
        const value = requireValue(arg, argv[++i])
        // Whole days, and not for ever: what is kept is key material, and a
        // forgotten unlock should run out on its own.
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 30) {
          throw new UsageError(`--days must be a whole number from 1 to 30 (got "${value}")`)
        }
        parsed.days = Number(value)
        break
      }
      case '--allow-drop':
        parsed.allowDrop = true
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

  if (commandless !== null) {
    throw new UsageError(`${commandless} needs a command`, undefined, true)
  }
  return parsed
}
