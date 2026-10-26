import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from '../src/args.js'
import {
  fencedBlocks,
  inlineCode,
  publicDocs,
  readDoc,
} from '../../engine/tests/fixtures/public-docs.js'

/**
 * Every `veilio` command and flag the public docs name, against `veilio --help`
 * from the built binary.
 *
 * readme-options.test.ts compares the CLI README's Options block with the
 * parser. A reader also learns commands from the root README, the guides, the
 * MCP and guard READMEs and the ROADMAP, and a command or flag can go stale in
 * any of them. The oracle here is the help a user would run. If the docs name
 * something `--help` does not, either the docs promise too much or the help
 * hides a real feature, and both are bugs.
 */
const DIST = resolve(import.meta.dirname, '..', 'dist', 'index.js')

let HELP = ''
beforeAll(() => {
  // Fail rather than skip, as binary.test.ts does: a skipped check on a
  // missing build reports green on exactly the run that built nothing.
  expect(existsSync(DIST), `${DIST} is missing; run \`npm run build\` first`).toBe(true)
  // An empty HOME, so the help is the same signed in or out and no real
  // sign-in on this machine is read.
  const home = mkdtempSync(join(tmpdir(), 'veilio-docs-'))
  HELP = execFileSync(process.execPath, [DIST, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  })
})

/** The commands `--help` lists: each entry's first word, and its second
 *  word when the second is a subcommand (`maps pull`, `team unlock`). */
function helpCommands(): { single: Set<string>; double: Set<string> } {
  const section = /\nCOMMANDS\n([\s\S]*?)\nOPTIONS\n/.exec(HELP)
  if (!section) throw new Error('veilio --help has no COMMANDS section')
  const single = new Set<string>()
  const double = new Set<string>()
  for (const m of section[1].matchAll(/^ {2}([a-z]+)(?: ([a-z]+))?(?= |$)/gm)) {
    single.add(m[1])
    if (m[2]) double.add(`${m[1]} ${m[2]}`)
  }
  return { single, double }
}

/** The help's sections, each entry with its wrapped lines joined. */
function helpEntries(section: 'COMMANDS' | 'OPTIONS'): string[] {
  const body = new RegExp(`\\n${section}\\n([\\s\\S]*?)\\n[A-Z][A-Z ]+\\n`).exec(HELP)
  if (!body) throw new Error(`veilio --help has no ${section} section`)
  const entries: string[] = []
  for (const line of body[1].split('\n')) {
    // An entry starts at column 2, or at column 6 for a flag with no short
    // form (`      --json`). A wrapped line is indented further.
    if (/^ {2}\S/.test(line) || (section === 'OPTIONS' && /^ {2,6}-/.test(line)))
      entries.push(line.trim())
    else if (/^ {4,}\S/.test(line) && entries.length > 0)
      entries[entries.length - 1] += ' ' + line.trim()
  }
  return entries
}

/**
 * Which commands each flag in `--help` belongs to. `null` means every command.
 *
 * The parser takes any flag with any command and ignores what does not apply,
 * so `veilio scrub --days 3` runs and the `--days` does nothing. The help is
 * the only place that says where a flag belongs. In OPTIONS it is a prefix
 * such as `login:` or `vault unlock, team unlock:`, a `restore:` later in the
 * text, or a list in brackets (`(scan, map)`). In COMMANDS it is a flag named
 * on a command's own line (`map … (--clear to wipe it)`, `scrub --team`). An
 * OPTIONS flag with no scope works with any command.
 *
 * Flags are read as tokens from the flag column and from the COMMANDS lines,
 * so `-f` is never found inside `--force`.
 */
function flagScopes(): Map<string, Set<string> | null> {
  const { single, double } = helpCommands()
  const isCommand = (c: string): boolean => single.has(c) || double.has(c)
  const scopes = new Map<string, Set<string> | null>()
  for (const entry of helpEntries('OPTIONS')) {
    const [column, ...rest] = entry.split(/ {2,}/)
    const description = rest.join(' ')
    const flags = [...column.matchAll(/(?<![\w-])(--?[a-z][\w-]*)/g)].map((m) => m[1])
    const scope = new Set<string>()
    for (const m of description.matchAll(
      /(?:^|[.;] )([a-z]+(?: [a-z]+)?(?:, [a-z]+(?: [a-z]+)?)*):/g
    ))
      for (const c of m[1].split(', ')) if (isCommand(c)) scope.add(c)
    for (const m of description.matchAll(/\(([a-z]+(?:, [a-z]+)+)\)/g))
      for (const c of m[1].split(', ')) if (isCommand(c)) scope.add(c)
    for (const f of flags) scopes.set(f, scope.size > 0 ? scope : null)
  }
  for (const entry of helpEntries('COMMANDS')) {
    const words = entry.split(/\s+/)
    const command = double.has(`${words[0]} ${words[1]}`) ? `${words[0]} ${words[1]}` : words[0]
    for (const m of entry.matchAll(/(?<![\w-])(--[a-z][\w-]*)/g)) {
      const known = scopes.get(m[1])
      if (known === null) continue
      const scope = known ?? new Set<string>()
      scope.add(command)
      scopes.set(m[1], scope)
    }
  }
  return scopes
}

interface Invocation {
  doc: string
  text: string
  words: string[]
}

/**
 * Each `veilio …` invocation in the docs' code: fenced shell or text blocks,
 * and inline code. Prose is left out, because the word "veilio" in a sentence
 * is the product, not the command.
 *
 * `veilio` counts only as a whole word, and so do the `npx` and `npm exec`
 * forms of `@veilio-inc/cli`. So `veilio-mcp`, `/veilio` (the guard's
 * slash command), `.veilio/`, `veilio-inc/veilio` and `veilio.dev` are not
 * matched. An invocation ends at a pipe, `;`, `&&`, `||`, a redirect or a
 * comment, so the flags of the next program (`git diff --cached`) are never
 * read as ours.
 */
function invocations(): Invocation[] {
  const found: Invocation[] = []
  for (const doc of publicDocs()) {
    const text = readDoc(doc)
    const code = [
      ...fencedBlocks(text, [
        '',
        'bash',
        'sh',
        'shell',
        'text',
        'console',
        'powershell',
        'yaml',
      ]).map((b) => b.code),
      ...inlineCode(text),
    ]
    for (const chunk of code) {
      for (const line of chunk.split('\n')) {
        const noComment = line.replace(/(^|\s)#.*$/, '')
        for (const segment of noComment.split(/\|\||&&|[|;()]|\$\(|\s[0-9]?>{1,2}\s?|\s<{1,3}\s/)) {
          // `veilio` must be the program: first on the segment, after any
          // `NAME=value` assignments. In `claude mcp add veilio -- …` it is an
          // argument to another program.
          // `npx @veilio-inc/cli …`, `npx -y @veilio-inc/cli@0.6.0 …` and
          // `npm exec [--yes] @veilio-inc/cli [--] …` run the same binary.
          const m = new RegExp(
            String.raw`^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)*` +
              String.raw`(?:veilio(?![\w.@/-])|(?:npx|npm\s+exec)(?:\s+(?:-y|--yes))*\s+@veilio-inc/cli(?:@\S+)?(?:\s+--(?=\s|$))?)` +
              String.raw`((?:\s+\S+)*)`
          ).exec(segment)
          if (!m) continue
          found.push({ doc, text: segment.trim(), words: m[1].trim().split(/\s+/).filter(Boolean) })
        }
      }
    }
  }
  return found
}

/** A word that names a value the reader supplies, not a command. */
function isPlaceholder(word: string): boolean {
  return /^[<[]/.test(word) || /[/.]/.test(word) || word.includes('*') || word.includes("'")
}

describe('veilio commands and flags in the public docs', () => {
  it('finds the invocations it is checking', () => {
    // A guard on the extraction: if the docs moved or the matcher broke, the
    // checks below would pass on nothing.
    const all = invocations()
    expect(all.length).toBeGreaterThan(80)
    expect(all.map((i) => i.text)).toEqual(
      expect.arrayContaining([
        'veilio scrub src/billing.ts',
        'veilio maps update <id>',
        'npx @veilio-inc/cli scrub src/billing.ts',
        'npx -y @veilio-inc/cli --help',
      ])
    )
  })

  it('names only commands that veilio --help lists', () => {
    const { single, double } = helpCommands()
    const wrong: string[] = []
    for (const inv of invocations()) {
      const [first, second] = inv.words
      if (first === undefined || first.startsWith('-') || isPlaceholder(first)) continue
      if (!single.has(first)) {
        wrong.push(`${inv.doc}: "${inv.text}" (no command "${first}")`)
        continue
      }
      const hasSubcommands = [...double].some((d) => d.startsWith(`${first} `))
      if (
        hasSubcommands &&
        second &&
        /^[a-z]+$/.test(second) &&
        !double.has(`${first} ${second}`)
      ) {
        // `projects` alone is a command too, so a bare word after it is a
        // subcommand only when one by that name exists. Anything else is
        // flagged, since the parser would read it as one.
        wrong.push(`${inv.doc}: "${inv.text}" (no command "${first} ${second}")`)
      }
    }
    expect(
      wrong,
      `the docs name commands veilio --help does not list:\n${wrong.join('\n')}`
    ).toEqual([])
  })

  it('names only flags that veilio --help lists, with a command they belong to', () => {
    const { double } = helpCommands()
    const scopes = flagScopes()
    const wrong: string[] = []
    for (const inv of invocations()) {
      const [first, second] = inv.words
      const command =
        first === undefined || first.startsWith('-')
          ? null
          : double.has(`${first} ${second}`)
            ? `${first} ${second}`
            : first
      for (const word of inv.words) {
        const flag = /^(--?[a-z][\w-]*)/.exec(word)?.[1]
        if (!flag) continue
        if (!scopes.has(flag)) {
          wrong.push(`${inv.doc}: "${inv.text}" (${flag} is not in --help)`)
          continue
        }
        const scope = scopes.get(flag)
        if (scope && !(command && (scope.has(command) || scope.has(command.split(' ')[0]))))
          wrong.push(
            `${inv.doc}: "${inv.text}" (--help gives ${flag} to ${[...scope].join(', ')}, not ${command ?? 'no command'})`
          )
      }
    }
    expect(
      wrong,
      `the docs use flags veilio --help does not give them:\n${wrong.join('\n')}`
    ).toEqual([])
  })

  it('reads where each flag belongs from --help', () => {
    // A guard on flagScopes: if the help changed shape and every flag came out
    // global, the check above would pass on anything.
    const scopes = flagScopes()
    expect(scopes.get('--days')).toEqual(new Set(['vault unlock', 'team unlock']))
    expect(scopes.get('--keep-docs')).toEqual(new Set(['restore']))
    expect(scopes.get('--strict')).toEqual(new Set(['scan', 'restore']))
    expect(scopes.get('--json')).toEqual(new Set(['scan', 'map']))
    expect(scopes.get('--clear')).toEqual(new Set(['map']))
    expect(scopes.get('--language')).toBeNull()
    expect(scopes.get('-f')).toBeNull()
  })

  it('lists in --help every flag the parser accepts', () => {
    // --help is a doc too, and the one a user reads first. `--device` worked
    // for a release with no line in it.
    const source = readDoc('packages/cli/src/args.ts')
    const parsed = [...source.matchAll(/case '(--?[a-z][\w-]*)':/g)].map((m) => m[1])
    const scopes = flagScopes()
    const hidden = parsed.filter((f) => !scopes.has(f))
    expect(
      hidden,
      `the parser accepts these and --help never names them: ${hidden.join(', ')}`
    ).toEqual([])
  })
})

describe('short and long flag pairs', () => {
  /** Run the parser, and describe a refusal in a form two spellings share. */
  function outcome(flag: string, spellings: readonly string[], rest: string[]): unknown {
    try {
      return parseArgs(['scrub', flag, ...rest])
    } catch (err) {
      // Longest first, so `--secrets` is replaced whole before `-s` could
      // match inside it.
      let message = err instanceof Error ? err.message : String(err)
      for (const s of [...spellings].sort((a, b) => b.length - a.length))
        message = message.split(s).join('<flag>')
      return { error: message }
    }
  }

  function pairs(): { where: string; short: string; long: string }[] {
    const sources = [
      { where: 'veilio --help', text: HELP },
      ...publicDocs().map((doc) => ({ where: doc, text: readDoc(doc) })),
    ]
    return sources.flatMap(({ where, text }) =>
      [...text.matchAll(/(?<![\w-])(-[a-z]), (--[a-z][\w-]*)/g)].map((m) => ({
        where,
        short: m[1],
        long: m[2],
      }))
    )
  }

  it('finds the pairs it is checking', () => {
    expect(pairs().filter((p) => p.where === 'veilio --help').length).toBeGreaterThan(6)
  })

  it('parse the same way', () => {
    // `-f, --force` was documented as one flag while `-f` set --team (0.5.4,
    // 0.6.0): a new case had been put between the two labels. A test that
    // reads the docs and asks the parser both spellings would have caught
    // it on the commit that caused it.
    const differ: string[] = []
    for (const { where, short, long } of pairs()) {
      // Each spelling alone, and each with a value, so a value-taking flag is
      // compared on what it does with its argument too.
      for (const rest of [[], ['typescript']]) {
        const both = [short, long]
        if (
          JSON.stringify(outcome(short, both, rest)) !== JSON.stringify(outcome(long, both, rest))
        )
          differ.push(`${where}: ${short} and ${long} parse differently`)
      }
    }
    expect([...new Set(differ)]).toEqual([])
  })
})
