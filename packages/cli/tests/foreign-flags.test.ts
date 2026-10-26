import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs, UsageError, type ParsedArgs } from '../src/args.js'
import {
  COMMAND_KEYS,
  FLAGS,
  HELP_WIDTH,
  belongsTo,
  commandHelp,
  optionsHelp,
  type CommandKey,
} from '../src/flags.js'
import { HELP, type Io } from '../src/commands.js'
import { main, run } from '../src/index.js'

/**
 * Each command refuses a flag that is not its own.
 *
 * Before this, the parser took any flag on any command and ignored the ones
 * that did not apply: `veilio scrub --days 3` ran, and `--days` did nothing.
 * A reader who puts a flag in a script believes it does something, so a flag
 * that does nothing has to be refused, as an unknown flag already was.
 */

/** A valid value for each value-taking flag, so a refusal is about the
 *  command and never about the value. */
const VALUES: Record<string, string> = {
  '--language': 'go',
  '--secrets': 'warn',
  '--map': 'some/map.json',
  '--days': '3',
  '--instance': 'https://veilio.example.com',
}

function withValue(spelling: string, long: string): string[] {
  const value = VALUES[long]
  return value === undefined ? [spelling] : [spelling, value]
}

function argvFor(command: CommandKey, spelling: string, long: string): string[] {
  return [...command.split(' '), ...withValue(spelling, long)]
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

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const home = mkdtempSync(join(tmpdir(), 'veilio-flags-'))
  const code = await main(argv, {
    cwd: home,
    home,
    env: {},
    stdin: () => Promise.resolve(''),
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
  })
  return { code, out, err }
}

const cases = COMMAND_KEYS.flatMap((command) =>
  FLAGS.flatMap((flag) =>
    [flag.long, ...(flag.short ? [flag.short] : [])].map((spelling) => ({
      command,
      flag,
      spelling,
    }))
  )
)

const SCRUB_OPTIONS =
  'Options for scrub: --language (-l), --secrets (-s), --preamble (-p), --map (-m), ' +
  '--force (-f), --team, --quiet (-q), --help (-h), --version (-v).'

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
      expect(err?.message).toMatch(
        new RegExp(`^${spelling} is not an option for ${command}\\. Options for ${command}: `)
      )
    }
  )

  it('is refused with exit code 2, naming the command and its options', async () => {
    const r = await cli(['scrub', '--days', '3'])
    expect(r.code).toBe(2)
    expect(r.err).toBe(
      `veilio scrub: --days is not an option for scrub. ${SCRUB_OPTIONS}\n\nRun "veilio --help" for usage.\n`
    )
  })

  it('lists only --help and --version for a command with no options of its own', () => {
    expect(refusal(['whoami', '--json'])?.message).toBe(
      '--json is not an option for whoami. Options for whoami: --help (-h), --version (-v).'
    )
  })
})

describe('an unknown flag', () => {
  it('names the command and its options, in the same wording', async () => {
    const r = await cli(['scrub', '--dayz'])
    expect(r.code).toBe(2)
    expect(r.err).toBe(
      `veilio scrub: unknown option --dayz. ${SCRUB_OPTIONS}\n\nRun "veilio --help" for usage.\n`
    )
  })

  it('keeps the general form when there is no command', async () => {
    const r = await cli(['--dayz'])
    expect(r.code).toBe(2)
    expect(r.err).toBe('veilio: unknown flag "--dayz"\n\nRun "veilio --help" for usage.\n')
  })
})

describe('--help anywhere on the line', () => {
  it('wins over a foreign flag before it', async () => {
    const r = await cli(['whoami', '--json', '--help'])
    expect(r.code).toBe(0)
    expect(r.out).toBe(commandHelp('whoami'))
  })

  it('wins over a foreign flag and its value, in its short form', async () => {
    const r = await cli(['scrub', '--days', '3', '-h'])
    expect(r.code).toBe(0)
    expect(r.out).toBe(commandHelp('scrub'))
  })

  it('wins over an unknown flag', async () => {
    const r = await cli(['scan', '--nope', '--help'])
    expect(r.code).toBe(0)
    expect(r.out).toBe(commandHelp('scan'))
  })

  it("shows a group's actions for a group, and one action for an action", async () => {
    expect((await cli(['maps', '--help'])).out).toBe(commandHelp('maps'))
    expect(commandHelp('maps')).toContain('maps update <id>')
    expect((await cli(['maps', 'pull', '-h'])).out).toBe(commandHelp('maps pull'))
    expect(commandHelp('maps pull')).not.toContain('maps update')
  })

  it('shows the general help with no command', async () => {
    const r = await cli(['--json', '--help'])
    expect(r.code).toBe(0)
    expect(r.out).toBe(HELP)
  })

  it("lists a command's own options in its help, and no other command's", () => {
    const help = commandHelp('team unlock')
    expect(help).toContain('--days')
    expect(help).not.toContain('--keep-docs')
  })
})

describe('flags before the command', () => {
  it('are read as if they followed it', () => {
    expect(parseArgs(['--json', 'scan', 'x'])).toEqual(parseArgs(['scan', '--json', 'x']))
    expect(parseArgs(['-q', 'scrub', 'a.ts'])).toEqual(parseArgs(['scrub', '-q', 'a.ts']))
    expect(parseArgs(['-m', 'm.json', 'scrub', 'a.ts'])).toEqual(
      parseArgs(['scrub', '-m', 'm.json', 'a.ts'])
    )
    expect(parseArgs(['--days', '3', 'team', 'unlock'])).toEqual(
      parseArgs(['team', 'unlock', '--days', '3'])
    )
  })

  it('are checked against that command', () => {
    expect(refusal(['--json', 'scrub', 'a.ts'])?.message).toMatch(
      /^--json is not an option for scrub\./
    )
    expect(refusal(['--days', '3', 'scrub'])?.command).toBe('scrub')
  })
})

describe('a line of flags with no command', () => {
  it('prints the general help and exits 2 for a flag that needs a command', async () => {
    const r = await cli(['--json'])
    expect(r.code).toBe(2)
    expect(r.err).toBe(`veilio: --json needs a command\n\n${HELP}`)
  })

  it('exits 2 even with --version beside it', async () => {
    expect((await cli(['-q', '--version'])).code).toBe(2)
  })

  it('answers --help and --version alone', async () => {
    expect(await cli(['--version'])).toMatchObject({ code: 0 })
    expect(await cli(['-h'])).toMatchObject({ code: 0, out: HELP })
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

  it('accepts --version on every command', () => {
    for (const command of COMMAND_KEYS)
      expect(parseArgs([...command.split(' '), '-v']).command).toBe('version')
  })
})

describe('the help', () => {
  const pages = [
    HELP,
    ...COMMAND_KEYS.map(commandHelp),
    ...['maps', 'team', 'vault'].map(commandHelp),
  ]

  it(`fits every line in ${HELP_WIDTH} columns`, () => {
    const long = pages.flatMap((p) => p.split('\n')).filter((l) => l.length > HELP_WIDTH)
    expect(long).toEqual([])
  })

  it('carries the notes a user needs', () => {
    const text = HELP.replace(/\s+/g, ' ')
    expect(text).toContain('7 by default')
    expect(text).toContain('Required for an SSO-bound account')
    expect(text).toContain('used automatically when the instance asks for a CAPTCHA')
    expect(text).toContain('for a map you intend to publish')
  })

  it('prints the table, with the commands each flag belongs to', () => {
    expect(HELP).toContain(optionsHelp())
    for (const flag of FLAGS)
      if (flag.commands !== 'all') {
        const forLine = `For: ${flag.commands.join(', ')}`.split(' ')
        expect(HELP.replace(/\s+/g, ' ')).toContain(forLine.join(' '))
      }
  })

  it('is what the README Options block says, word for word', () => {
    const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8')
    const block = /## Options\s*\n+```\n([\s\S]*?)```/.exec(readme)?.[1]
    const expected = optionsHelp()
      .split('\n')
      .map((l) => l.replace(/^ {2}/, ''))
      .join('\n')
    expect(block?.trimEnd()).toBe(expected)
  })
})

describe('the tables are the one source', () => {
  it('lists every flag the parser handles, and the parser handles every flag it lists', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'args.ts'), 'utf8')
    const handled = [...source.matchAll(/case '(--[a-z][\w-]*)':/g)].map((m) => m[1]).sort()
    expect(handled).toEqual(FLAGS.map((f) => f.long).sort())
  })

  it('makes every command key a command the parser accepts', () => {
    for (const command of COMMAND_KEYS) expect(() => parseArgs(command.split(' '))).not.toThrow()
  })
})

/**
 * The flag table against what each command's code reads.
 *
 * The table can be wrong in two ways the tests above cannot see. A flag listed
 * for a command that never reads it is ignored silently again. A flag the
 * command reads but the table leaves out is refused. So each command is run
 * with its `args` wrapped in a Proxy that records every property read: a
 * destructured read and a read inside a helper are both property reads, so
 * neither can hide. I/O is stubbed: an empty home (nobody signed in), a temp
 * project, a prompt that refuses, and a `fetch` that fails, so no command
 * leaves the machine.
 *
 * A branch reads only on its own path, so each command runs once with no
 * flags and once with each of its flags set, and the reads are pooled.
 */
describe('the flag table and the code', () => {
  const FIELD_FLAG = new Map(FLAGS.filter((f) => f.field).map((f) => [f.field as string, f.long]))
  let project = ''

  beforeAll(() => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in this test')))
    project = mkdtempSync(join(tmpdir(), 'veilio-reads-'))
    writeFileSync(join(project, 'a.ts'), 'class PaymentService { charge(orderId) {} }\n')
  })
  afterAll(() => vi.unstubAllGlobals())

  function io(): Io {
    return {
      cwd: project,
      home: mkdtempSync(join(tmpdir(), 'veilio-reads-home-')),
      env: {},
      stdin: () => Promise.resolve('class PaymentService { charge(orderId) {} }\n'),
      stdout: () => {},
      stderr: () => {},
      prompt: () => Promise.reject(new Error('no prompt in this test')),
      password: () => Promise.reject(new Error('no prompt in this test')),
    }
  }

  async function reads(argv: string[]): Promise<Set<string>> {
    const seen = new Set<string>()
    const args = new Proxy(parseArgs(argv), {
      get(target, prop, receiver) {
        if (typeof prop === 'string') seen.add(prop)
        return Reflect.get(target, prop, receiver) as unknown
      },
    }) as ParsedArgs
    await run(args, io())
    return seen
  }

  it.each(COMMAND_KEYS.map((k) => [k] as const))(
    '%s reads exactly the flags the table gives it',
    async (command) => {
      // Prepared first: restore and map need a map to read before they get
      // to the flags that act on it.
      await run(parseArgs(['scrub', 'a.ts']), io())
      const listed = FLAGS.filter((f) => f.commands !== 'all' && f.commands.includes(command))
      const pooled = new Set<string>()
      const base = [...command.split(' '), ...(command.includes(' ') ? ['an-id'] : [])]
      for (const extra of [[], ...listed.map((f) => withValue(f.long, f.long))]) {
        for (const field of await reads([...base, ...extra])) {
          const flag = FIELD_FLAG.get(field)
          if (flag) pooled.add(flag)
        }
      }
      expect([...pooled].sort()).toEqual(listed.map((f) => f.long).sort())
    },
    30_000
  )
})
