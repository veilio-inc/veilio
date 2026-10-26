/**
 * Every command and every flag, in one table. The parser reads its commands,
 * group verbs and flags from here. `--help` (general and per command) is
 * rendered from here. The docs test reads it. So a new action or flag is
 * added in one place, and the parser, the help and the docs check cannot drift
 * apart.
 *
 * Before this table, the parser took any flag on any command and ignored the
 * ones that did not apply: `veilio scrub --days 3` ran, and `--days` did
 * nothing. That is the same silent failure as the engine's removed
 * `options.style`. A reader who writes a flag into a script believes it does
 * something. Now a flag on a command it does not belong to is refused, with
 * exit code 2 and the list of options that command does take.
 */
import { BIN_NAME, STORE_DIR } from '@veilio-inc/engine'

export interface CommandSpec {
  /** A top-level command, or a group with its action (`maps pull`). */
  readonly key: string
  /** Reaches the network. Listed after the offline commands in `--help`. */
  readonly cloud: boolean
  /** Its lines in the COMMANDS section of `--help`. */
  readonly help: readonly { readonly usage: string; readonly text: string }[]
}

/** In the order `--help` prints them. */
export const COMMAND_SPECS = [
  {
    key: 'scrub',
    cloud: false,
    help: [
      { usage: 'scrub --team', text: "Number new placeholders from the team's allocation." },
      {
        usage: 'scrub [files...]',
        text: `Mask identifiers and redact credentials. Reads stdin when no file is given. Writes the symbol map to ${STORE_DIR}/map.json.`,
      },
    ],
  },
  {
    key: 'restore',
    cloud: false,
    help: [
      {
        usage: 'restore [files...]',
        text: 'Swap placeholders back and strip AI-generated noise.',
      },
    ],
  },
  {
    key: 'scan',
    cloud: false,
    help: [
      {
        usage: 'scan [files...]',
        text: 'Detect credentials only; never rewrites. Exits 1 on a credential (with --strict, on any finding) — use it in a pre-commit hook or CI.',
      },
    ],
  },
  {
    key: 'map',
    cloud: false,
    help: [{ usage: 'map', text: 'Show the current symbol map (--clear to wipe it).' }],
  },
  {
    key: 'login',
    cloud: true,
    help: [
      {
        usage: 'login',
        text: 'Sign in to Veilio Cloud (--instance for self-hosted, --device to approve in a browser).',
      },
    ],
  },
  {
    key: 'logout',
    cloud: true,
    help: [{ usage: 'logout', text: 'Revoke the session and forget the credential.' }],
  },
  {
    key: 'whoami',
    cloud: true,
    help: [
      {
        usage: 'whoami',
        text: 'Show the signed-in account. Answers from disk; makes no request, so it works with the instance down.',
      },
    ],
  },
  {
    key: 'maps list',
    cloud: true,
    help: [{ usage: 'maps list', text: 'List the maps this account holds in Cloud.' }],
  },
  {
    key: 'maps pull',
    cloud: true,
    help: [
      {
        usage: 'maps pull <id>',
        text: 'Fetch one into the local store. A personal map is decrypted here — the passphrase never leaves the machine. A team map opens with the key from `team unlock`.',
      },
    ],
  },
  {
    key: 'maps push',
    cloud: true,
    help: [
      {
        usage: 'maps push [name]',
        text: 'Encrypt the local map and upload it as a new map.',
      },
      { usage: 'maps push --team', text: "Publish it as the TEAM's shared map instead." },
    ],
  },
  {
    key: 'maps update',
    cloud: true,
    help: [
      {
        usage: 'maps update <id>',
        text: "Replace a Cloud map's entries with the local map's, in place: same id, name and project. Refuses to drop entries unless --allow-drop is given.",
      },
    ],
  },
  {
    key: 'maps rm',
    cloud: true,
    help: [{ usage: 'maps rm <id>', text: 'Remove a map from Cloud.' }],
  },
  {
    key: 'team unlock',
    cloud: true,
    help: [
      {
        usage: 'team unlock',
        text: "Open this account's team keys with the vault passphrase and keep them on this machine (7 days), so team maps - and the MCP server's shared namespace - work unattended.",
      },
    ],
  },
  {
    key: 'team lock',
    cloud: true,
    help: [{ usage: 'team lock', text: 'Remove the unlocked team keys from this machine.' }],
  },
  {
    key: 'vault unlock',
    cloud: true,
    help: [
      {
        usage: 'vault unlock',
        text: "Unlock the personal-maps key with the vault passphrase and keep only that key here (7 days), so personal maps - and the MCP server's map tools - work without a passphrase. Re-seals older personal maps under it.",
      },
    ],
  },
  {
    key: 'vault lock',
    cloud: true,
    help: [{ usage: 'vault lock', text: 'Remove the personal-maps key from this machine.' }],
  },
  {
    key: 'projects',
    cloud: true,
    help: [
      {
        usage: 'projects',
        text: 'List the projects your team works in; * marks the one in use. A team map belongs to exactly one project.',
      },
    ],
  },
  {
    key: 'projects list',
    cloud: true,
    help: [{ usage: 'projects list', text: 'The same as `projects`.' }],
  },
  {
    key: 'projects use',
    cloud: true,
    help: [
      {
        usage: 'projects use <name>',
        text: 'Work in that project: team maps, pushes, updates and scrub --team use it only. Kept with the sign-in, so the MCP server uses it too. VEILIO_PROJECT=<name|id> overrides it for one shell, CI job or MCP server.',
      },
    ],
  },
  {
    key: 'rules pull',
    cloud: true,
    help: [
      {
        usage: 'rules pull',
        text: "Fetch this account's custom rules (personal and team). `scrub` then applies them offline, as the web app does.",
      },
    ],
  },
] as const satisfies readonly CommandSpec[]

/** The command a flag is checked against: a top-level command, or a group
 *  command with its action (`maps pull`). */
export type CommandKey = (typeof COMMAND_SPECS)[number]['key']

/** The first word of a key: `maps` for `maps pull`. */
export type CommandWord<K extends string = CommandKey> = K extends `${infer W} ${string}` ? W : K

/** The actions of a group: `'list' | 'pull' | …` for `maps`. */
export type ActionOf<G extends string> = CommandKey extends infer K
  ? K extends `${G} ${infer A}`
    ? A
    : never
  : never

export const COMMAND_KEYS: readonly CommandKey[] = COMMAND_SPECS.map((c) => c.key)

/** Every top-level word the parser accepts as a command, in table order. */
export const COMMAND_WORDS: readonly string[] = [
  ...new Set(COMMAND_KEYS.map((k) => k.split(' ')[0])),
]

/** The actions of a group, in table order. Empty for a plain command. */
export function actionsOf(word: string): string[] {
  return COMMAND_KEYS.filter((k) => k.startsWith(`${word} `)).map((k) => k.split(' ')[1])
}

/** Whether a group can also run with no action (`projects` lists). */
export function runsBare(word: string): boolean {
  return (COMMAND_KEYS as readonly string[]).includes(word)
}

/** `list, pull, push, update or rm`, for the messages that name the actions. */
export function actionList(word: string): string {
  const actions = actionsOf(word)
  return actions.length > 1
    ? `${actions.slice(0, -1).join(', ')} or ${actions[actions.length - 1]}`
    : (actions[0] ?? '')
}

export interface FlagSpec {
  long: string
  short?: string
  /** The value's placeholder in `--help` (`<lang>`). Absent: a switch. */
  value?: string
  /** What the flag does, and the notes a user needs. Wrapped by `--help`. */
  help: string
  /** The commands this flag belongs to. `'all'`: every command. */
  commands: readonly CommandKey[] | 'all'
  /** The ParsedArgs field it sets. The table-vs-code test reads it. */
  field?: string
}

export const FLAGS: readonly FlagSpec[] = [
  {
    long: '--language',
    short: '-l',
    value: '<lang>',
    help: 'auto (default), typescript, python, go, java, csharp, rust, ruby, php, c, sql',
    commands: ['scrub'],
    field: 'language',
  },
  {
    long: '--secrets',
    short: '-s',
    value: '<policy>',
    help: 'redact (default) | warn | off',
    commands: ['scrub'],
    field: 'secrets',
  },
  {
    long: '--preamble',
    short: '-p',
    help: 'Prepend the downstream-AI note and placeholder legend',
    commands: ['scrub'],
    field: 'preamble',
  },
  {
    long: '--map',
    short: '-m',
    value: '<path>',
    help: 'Use a specific map file',
    commands: ['scrub', 'restore', 'map', 'maps pull', 'maps push', 'maps update'],
    field: 'mapPath',
  },
  {
    long: '--json',
    help: 'Machine-readable output',
    commands: ['scan', 'map'],
    field: 'json',
  },
  {
    long: '--strict',
    help: 'scan: also fail on advisory findings. restore: write nothing and exit 1 if a placeholder would be left',
    commands: ['scan', 'restore'],
    field: 'strict',
  },
  {
    long: '--keep-docs',
    help: 'Keep JSDoc blocks the model wrote',
    commands: ['restore'],
    field: 'keepDocs',
  },
  {
    long: '--clear',
    help: 'Wipe the symbol map',
    commands: ['map'],
    field: 'clear',
  },
  {
    long: '--force',
    short: '-f',
    help: 'Allow a map write that would drop existing entries',
    commands: ['scrub', 'maps pull'],
    field: 'force',
  },
  {
    long: '--team',
    help: "scrub: number new placeholders out of the team's shared allocation, for a map you intend to publish. maps push: publish as the team's shared map",
    commands: ['scrub', 'maps push'],
    field: 'team',
  },
  {
    long: '--days',
    value: '<n>',
    help: 'Keep the key for n days (1 to 30; 7 by default)',
    commands: ['team unlock', 'vault unlock'],
    field: 'days',
  },
  {
    long: '--allow-drop',
    help: 'Allow dropping entries the Cloud map has and the local map does not',
    commands: ['maps update'],
    field: 'allowDrop',
  },
  {
    long: '--quiet',
    short: '-q',
    help: 'Suppress the all-clear summary (findings always show)',
    commands: ['scrub', 'restore', 'scan'],
    field: 'quiet',
  },
  {
    long: '--device',
    help: 'Sign in through a browser instead of typing a password here. Required for an SSO-bound account, and used automatically when the instance asks for a CAPTCHA',
    commands: ['login'],
    field: 'device',
  },
  {
    long: '--instance',
    value: '<url>',
    help: 'The Veilio instance to sign in to. Defaults to the public Cloud; https required (localhost excepted)',
    // Only `login` reads it. Every later command takes the instance from the
    // stored sign-in, so a command cannot be pointed at another host while it
    // holds the first one's token. Accepting it elsewhere would let
    // `veilio whoami --instance …` look like a check of that host.
    commands: ['login'],
    field: 'instance',
  },
  { long: '--help', short: '-h', help: 'Show this help', commands: 'all' },
  { long: '--version', short: '-v', help: 'Show the version', commands: 'all' },
]

const BY_SPELLING = new Map<string, FlagSpec>()
for (const f of FLAGS) {
  BY_SPELLING.set(f.long, f)
  if (f.short) BY_SPELLING.set(f.short, f)
}

/** The flag a spelling (`-l` or `--language`) names, if any. */
export function flagFor(spelling: string): FlagSpec | undefined {
  return BY_SPELLING.get(spelling)
}

export function belongsTo(flag: FlagSpec, command: CommandKey): boolean {
  return flag.commands === 'all' || flag.commands.includes(command)
}

/** The flags a command takes, the ones for every command included. */
export function flagsOf(command: CommandKey): FlagSpec[] {
  return FLAGS.filter((f) => belongsTo(f, command))
}

/** `--language (-l)`, for an error message. */
export function spell(flag: FlagSpec): string {
  return flag.short ? `${flag.long} (${flag.short})` : flag.long
}

/** Every line of `--help` fits in this many columns. */
export const HELP_WIDTH = 80

/** Words of `text`, in lines no wider than `width`. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
}

/** A two-column block: each name, then its text wrapped under a column. */
function columns(rows: readonly { name: string; text: string }[], column: number): string {
  const out: string[] = []
  for (const { name, text } of rows) {
    const body = wrap(text, HELP_WIDTH - column)
    const first =
      name.length + 2 < column ? `  ${name.padEnd(column - 2)}${body[0] ?? ''}` : `  ${name}`
    out.push(first)
    const rest = name.length + 2 < column ? body.slice(1) : body
    for (const line of rest) out.push(`${' '.repeat(column)}${line}`)
  }
  return out.join('\n')
}

const OPTION_COLUMN = 26
const COMMAND_COLUMN = 23

function optionName(f: FlagSpec): string {
  return `${f.short ? `${f.short}, ` : '    '}${f.long}${f.value ? ` ${f.value}` : ''}`
}

/** The OPTIONS block for some flags: each flag, its text, and the commands
 *  it belongs to, every line within HELP_WIDTH. */
export function optionsHelp(flags: readonly FlagSpec[] = FLAGS): string {
  const out: string[] = []
  for (const f of flags) {
    out.push(columns([{ name: optionName(f), text: f.help }], OPTION_COLUMN))
    if (f.commands !== 'all') {
      const forLines = wrap(`For: ${f.commands.join(', ')}`, HELP_WIDTH - OPTION_COLUMN)
      for (const line of forLines) out.push(`${' '.repeat(OPTION_COLUMN)}${line}`)
    }
  }
  return out.join('\n')
}

/** The COMMANDS block for some commands. */
export function commandsHelp(specs: readonly CommandSpec[]): string {
  return columns(
    specs.flatMap((c) => c.help.map((h) => ({ name: h.usage, text: h.text }))),
    COMMAND_COLUMN
  )
}

/** The COMMANDS section of the general help: the offline commands, a note,
 *  then the ones that reach the network. */
export function allCommandsHelp(): string {
  const offline = COMMAND_SPECS.filter((c) => !c.cloud)
  const cloud = COMMAND_SPECS.filter((c) => c.cloud)
  const note = wrap(
    'Everything above works offline, with no account. The commands below connect a Veilio Cloud subscription and are the only ones that touch the network.',
    HELP_WIDTH - 2
  )
    .map((l) => `  ${l}`)
    .join('\n')
  return `${commandsHelp(offline)}\n\n${note}\n\n${commandsHelp(cloud)}`
}

/** `veilio scrub --help`: that command's lines and its own options. For a
 *  group with no action (`veilio maps --help`), every action of the group. */
export function commandHelp(topic: string): string {
  const specs = COMMAND_SPECS.filter((c) => c.key === topic || c.key.startsWith(`${topic} `))
  const keys = specs.map((c) => c.key)
  const flags = FLAGS.filter((f) => keys.some((k) => belongsTo(f, k)))
  return (
    `${BIN_NAME} ${topic}\n\nUSAGE\n${specs
      .flatMap((c) => c.help.map((h) => `  ${BIN_NAME} ${h.usage}`))
      .join('\n')}\n\n` + `COMMANDS\n${commandsHelp(specs)}\n\nOPTIONS\n${optionsHelp(flags)}\n`
  )
}
