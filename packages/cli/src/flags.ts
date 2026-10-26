/**
 * Every flag, and the commands each one belongs to. This is the one list the
 * parser checks against, the one `--help` prints, and the one the docs test
 * reads, so the three cannot drift apart.
 *
 * Before this table, the parser took any flag on any command and ignored the
 * ones that did not apply: `veilio scrub --days 3` ran, and `--days` did
 * nothing. That is the same silent failure as the engine's removed
 * `options.style`. A reader who writes a flag into a script believes it does
 * something. Now a flag on a command it does not belong to is refused, with
 * exit code 2 and the list of options that command does take.
 */

/** The command a flag is checked against: a top-level command, or a group
 *  command with its action (`maps pull`). */
export type CommandKey =
  | 'scrub'
  | 'restore'
  | 'scan'
  | 'map'
  | 'login'
  | 'logout'
  | 'whoami'
  | 'maps list'
  | 'maps pull'
  | 'maps push'
  | 'maps update'
  | 'maps rm'
  | 'team unlock'
  | 'team lock'
  | 'vault unlock'
  | 'vault lock'
  | 'projects'
  | 'projects list'
  | 'projects use'
  | 'rules pull'

export interface FlagSpec {
  long: string
  short?: string
  /** The value's placeholder in `--help` (`<lang>`). Absent: a switch. */
  value?: string
  /** The description `--help` prints, one entry per line. */
  help: readonly string[]
  /** The commands this flag belongs to. `'all'`: every command. */
  commands: readonly CommandKey[] | 'all'
}

export const FLAGS: readonly FlagSpec[] = [
  {
    long: '--language',
    short: '-l',
    value: '<lang>',
    help: ['auto (default), typescript, python, go, java, csharp,', 'rust, ruby, php, c, sql'],
    commands: ['scrub'],
  },
  {
    long: '--secrets',
    short: '-s',
    value: '<policy>',
    help: ['redact (default) | warn | off'],
    commands: ['scrub'],
  },
  {
    long: '--preamble',
    short: '-p',
    help: ['Prepend the downstream-AI note and placeholder legend'],
    commands: ['scrub'],
  },
  {
    long: '--map',
    short: '-m',
    value: '<path>',
    help: ['Use a specific map file'],
    commands: ['scrub', 'restore', 'map', 'maps pull', 'maps push', 'maps update'],
  },
  {
    long: '--json',
    help: ['Machine-readable output'],
    commands: ['scan', 'map'],
  },
  {
    long: '--strict',
    help: [
      'scan: also fail on advisory findings. restore: write',
      'nothing and exit 1 if a placeholder would be left',
    ],
    commands: ['scan', 'restore'],
  },
  {
    long: '--keep-docs',
    help: ['Keep JSDoc blocks the model wrote'],
    commands: ['restore'],
  },
  {
    long: '--clear',
    help: ['Wipe the symbol map'],
    commands: ['map'],
  },
  {
    long: '--force',
    short: '-f',
    help: ['Allow a map write that would drop existing entries'],
    commands: ['scrub', 'maps pull'],
  },
  {
    long: '--team',
    help: [
      "scrub: number new placeholders from the team's",
      "allocation. maps push: publish as the team's map",
    ],
    commands: ['scrub', 'maps push'],
  },
  {
    long: '--days',
    value: '<n>',
    help: ['Keep the key n days (1-30)'],
    commands: ['team unlock', 'vault unlock'],
  },
  {
    long: '--allow-drop',
    help: ['Allow dropping entries the Cloud map has'],
    commands: ['maps update'],
  },
  {
    long: '--quiet',
    short: '-q',
    help: ['Suppress the all-clear summary (findings always show)'],
    commands: ['scrub', 'restore', 'scan'],
  },
  {
    long: '--device',
    help: ['Approve the sign-in in a browser instead of', 'typing a password here'],
    commands: ['login'],
  },
  {
    long: '--instance',
    value: '<url>',
    help: [
      'The Veilio instance to sign in to. Defaults to',
      'the public Cloud; https required (localhost excepted)',
    ],
    // Only `login` reads it. Every later command takes the instance from the
    // stored sign-in, so a command cannot be pointed at another host while it
    // holds the first one's token. Accepting it elsewhere would let
    // `veilio whoami --instance …` look like a check of that host.
    commands: ['login'],
  },
  { long: '--help', short: '-h', help: ['Show this help'], commands: 'all' },
  { long: '--version', short: '-v', help: ['Show the version'], commands: 'all' },
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

/** The flags a command takes, the ones for every command included. */
export function flagsOf(command: CommandKey): FlagSpec[] {
  return FLAGS.filter((f) => f.commands === 'all' || f.commands.includes(command))
}

export function belongsTo(flag: FlagSpec, command: CommandKey): boolean {
  return flag.commands === 'all' || flag.commands.includes(command)
}

/** `--language (-l)`, for an error message. */
export function spell(flag: FlagSpec): string {
  return flag.short ? `${flag.long} (${flag.short})` : flag.long
}

/** The OPTIONS section of `--help`, rendered from the table: each flag, its
 *  description, and the commands it belongs to. */
export function optionsHelp(): string {
  const COLUMN = 24
  const lines: string[] = []
  for (const f of FLAGS) {
    const name = `${f.short ? `${f.short}, ` : '    '}${f.long}${f.value ? ` ${f.value}` : ''}`
    const description = [...f.help]
    if (f.commands !== 'all') description.push(`For: ${f.commands.join(', ')}`)
    lines.push(`  ${name.padEnd(COLUMN)}${description[0]}`)
    for (const rest of description.slice(1)) lines.push(`  ${' '.repeat(COLUMN)}${rest}`)
  }
  return lines.join('\n')
}
