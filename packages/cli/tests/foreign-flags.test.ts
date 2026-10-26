import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs, UsageError } from '../src/args.js'
import { FLAGS, belongsTo, type CommandKey } from '../src/flags.js'
import { HELP } from '../src/commands.js'
import { main } from '../src/index.js'

/**
 * Each command refuses a flag that is not its own.
 *
 * Before this, the parser took any flag on any command and ignored the ones
 * that did not apply: `veilio scrub --days 3` ran, and `--days` did nothing.
 * A reader who puts a flag in a script believes it does something, so a flag
 * that does nothing has to be refused, as an unknown flag already was.
 */
const COMMANDS: readonly CommandKey[] = [
  'scrub',
  'restore',
  'scan',
  'map',
  'login',
  'logout',
  'whoami',
  'maps list',
  'maps pull',
  'maps push',
  'maps update',
  'maps rm',
  'team unlock',
  'team lock',
  'vault unlock',
  'vault lock',
  'projects',
  'projects list',
  'projects use',
  'rules pull',
]

/** A valid value for each value-taking flag, so a refusal is about the
 *  command and never about the value. */
const VALUES: Record<string, string> = {
  '--language': 'go',
  '--secrets': 'warn',
  '--map': 'some/map.json',
  '--days': '3',
  '--instance': 'https://veilio.example.com',
}

function argvFor(command: CommandKey, spelling: string, long: string): string[] {
  const value = VALUES[long]
  return [...command.split(' '), spelling, ...(value === undefined ? [] : [value])]
}

function refusal(argv: string[]): UsageError | null {
  try {
    parseArgs(argv)
    return null
  } catch (err) {
    if (err instanceof UsageError) return err
    throw err
  }
}

const cases = COMMANDS.flatMap((command) =>
  FLAGS.flatMap((flag) =>
    [flag.long, ...(flag.short ? [flag.short] : [])].map((spelling) => ({
      command,
      flag,
      spelling,
    }))
  )
)

describe('a flag on a command it does not belong to', () => {
  const foreign = cases.filter(({ command, flag }) => !belongsTo(flag, command))

  it('has cases to check', () => {
    expect(foreign.length).toBeGreaterThan(200)
  })

  it.each(foreign.map((c) => [`${c.command} ${c.spelling}`, c] as const))(
    'refuses %s',
    (_label, { command, flag, spelling }) => {
      const err = refusal(argvFor(command, spelling, flag.long))
      expect(err, `${command} accepted ${spelling}`).not.toBeNull()
      expect(err?.command).toBe(command)
      expect(err?.message).toMatch(new RegExp(`^unknown option ${spelling}\\. `))
    }
  )

  it('is refused with exit code 2 and the options the command does take', async () => {
    const stderr: string[] = []
    const code = await main(['scrub', '--days', '3'], {
      cwd: process.cwd(),
      stdin: () => Promise.resolve(''),
      stdout: () => {},
      stderr: (s) => stderr.push(s),
    })
    expect(code).toBe(2)
    expect(stderr.join('')).toBe(
      'veilio scrub: unknown option --days. Options for scrub: --language (-l), --secrets (-s), ' +
        '--preamble (-p), --map (-m), --force (-f), --team, --quiet (-q), --help (-h), --version (-v).' +
        '\n\nRun "veilio --help" for usage.\n'
    )
  })

  it('names the command, and says when it takes no options', () => {
    const err = refusal(['whoami', '--json'])
    expect(err?.command).toBe('whoami')
    expect(err?.message).toBe(
      'unknown option --json. whoami takes no options of its own; --help (-h) and --version (-v) work with any command.'
    )
  })
})

describe('a flag on a command it belongs to', () => {
  const own = cases.filter(({ command, flag }) => belongsTo(flag, command))

  it.each(own.map((c) => [`${c.command} ${c.spelling}`, c] as const))(
    'accepts %s',
    (_label, { command, flag, spelling }) => {
      expect(refusal(argvFor(command, spelling, flag.long))).toBeNull()
    }
  )

  it.each(
    own
      .filter((c) => c.flag.short && c.spelling === c.flag.short)
      .map((c) => [`${c.command} ${c.flag.short} = ${c.flag.long}`, c] as const)
  )('parses %s the same', (_label, { command, flag }) => {
    expect(parseArgs(argvFor(command, flag.short ?? '', flag.long))).toEqual(
      parseArgs(argvFor(command, flag.long, flag.long))
    )
  })

  it('accepts --help and --version on every command', () => {
    for (const command of COMMANDS) {
      expect(parseArgs([...command.split(' '), '--help']).command).toBe('help')
      expect(parseArgs([...command.split(' '), '-v']).command).toBe('version')
    }
  })
})

describe('the flag table is the one source', () => {
  it('lists every flag the parser handles, and the parser handles every flag it lists', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'args.ts'), 'utf8')
    const handled = [...source.matchAll(/case '(--[a-z][\w-]*)':/g)].map((m) => m[1]).sort()
    expect(handled).toEqual(FLAGS.map((f) => f.long).sort())
  })

  it('is what --help prints, with the commands each flag belongs to', () => {
    for (const flag of FLAGS) {
      expect(HELP).toContain(flag.long)
      if (flag.commands !== 'all') expect(HELP).toContain(`For: ${flag.commands.join(', ')}`)
    }
  })

  it('gives each command exactly the flags its code reads', () => {
    // The table can be wrong in two ways the other tests cannot see: a flag
    // listed for a command that never reads it is ignored silently again, and
    // a flag the command reads but the table leaves out is refused. So the
    // table is compared with the code: the \`args.<field>\` each command reads,
    // in its run function (commands.ts) or its branch of the dispatch
    // (index.ts).
    const FIELD_FLAG: Record<string, string> = {
      language: '--language',
      secrets: '--secrets',
      preamble: '--preamble',
      mapPath: '--map',
      json: '--json',
      strict: '--strict',
      keepDocs: '--keep-docs',
      clear: '--clear',
      force: '--force',
      team: '--team',
      days: '--days',
      allowDrop: '--allow-drop',
      quiet: '--quiet',
      device: '--device',
      instance: '--instance',
    }
    const commands = readFileSync(join(import.meta.dirname, '..', 'src', 'commands.ts'), 'utf8')
    const index = readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')
    const dispatch = index.slice(index.indexOf('switch (args.command) {'))

    /** The text up to the next case of the same switch. */
    const caseBody = (text: string, label: string): string => {
      const start = text.indexOf(`case '${label}':`)
      if (start === -1) throw new Error(`no case '${label}' in the dispatch`)
      const rest = text.slice(start + label.length + 8)
      const end = rest.search(/\n\s*(case '|default:)/)
      return end === -1 ? rest : rest.slice(0, end)
    }
    const runBody = (fn: string): string => {
      const start = commands.indexOf(`export async function ${fn}(`)
      if (start === -1) throw new Error(`no ${fn} in commands.ts`)
      const end = commands.indexOf('\nexport ', start + 1)
      return commands.slice(start, end === -1 ? undefined : end)
    }
    const codeFor = (command: CommandKey): string => {
      const local: Record<string, string> = {
        scrub: 'runScrub',
        restore: 'runRestore',
        scan: 'runScan',
        map: 'runMap',
      }
      if (local[command]) return runBody(local[command])
      const [group, action] = command.split(' ')
      if (!action) return caseBody(dispatch, group)
      const groupBody = dispatch.slice(dispatch.indexOf(`case '${group}':`))
      if (group === 'projects') {
        // `projects use` is an if; the rest of the branch is the listing.
        const branch = caseBody(dispatch, 'projects')
        const [use, list] = branch.split('\n').filter((l) => l.includes('return'))
        return action === 'use' ? use : list
      }
      if (group === 'rules') return caseBody(dispatch, 'rules')
      // The local map path is resolved once for every maps action, and only
      // the actions that pass \`mapPath\` on use it.
      return caseBody(groupBody, action)
    }

    const mismatched: string[] = []
    for (const command of COMMANDS) {
      const code = codeFor(command)
      const read = new Set<string>()
      for (const m of code.matchAll(/\bargs\.(\w+)/g))
        if (FIELD_FLAG[m[1]]) read.add(FIELD_FLAG[m[1]])
      if (command.startsWith('maps ') && /\bmapPath\b/.test(code)) read.add('--map')
      const listed = new Set(
        FLAGS.filter((f) => f.commands !== 'all' && f.commands.includes(command)).map((f) => f.long)
      )
      const missing = [...read].filter((f) => !listed.has(f))
      const extra = [...listed].filter((f) => !read.has(f))
      if (missing.length || extra.length)
        mismatched.push(
          `${command}: reads ${missing.join(', ') || 'nothing more'} the table leaves out; ` +
            `the table gives it ${extra.join(', ') || 'nothing more'} it never reads`
        )
    }
    expect(mismatched).toEqual([])
  })

  it('names every command key the parser can produce', () => {
    // A group command with no action (`veilio maps`) is refused before any
    // flag is checked; every other command resolves to one of these keys.
    for (const command of COMMANDS) expect(() => parseArgs(command.split(' '))).not.toThrow()
  })
})
