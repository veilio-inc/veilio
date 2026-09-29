import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs, UsageError } from '../src/args.js'

/**
 * The README's Options block against the flags the parser actually accepts.
 *
 * Written after an audit found three flags — `--keep-docs`, `--force` and
 * `--instance` — that had shipped to npm undocumented, and one README option on
 * the engine side (`options.style`) that had been advertised for seven published
 * versions after the code was deleted. Nothing could see either: a README is the
 * one file nobody typechecks, and the failure is silent in both directions. An
 * undocumented flag is a feature nobody can find; a documented flag that does
 * not exist is worse, because a reader writes it into a script and it fails at
 * the moment they trusted it.
 *
 * The README is parsed rather than duplicated here on purpose. A hardcoded list
 * of expected flags is a third copy to keep in sync, and the second copy is
 * already what went wrong.
 */
const README = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8')
const ARGS_SOURCE = readFileSync(join(import.meta.dirname, '..', 'src', 'args.ts'), 'utf8')

/** Every flag named anywhere in the README, in any context.
 *
 *  Deliberately wider than the Options block: `--clear` belongs to `map` and is
 *  documented in the Commands table, exactly as `veilio --help` presents it.
 *  Forcing it into the options list to satisfy a test would make the README
 *  disagree with the help output to agree with this file, which is backwards. */
function mentionedFlags(): string[] {
  const flags: string[] = []
  for (const m of README.matchAll(/(?<![\w-])(--?[a-z][\w-]*)/g)) flags.push(m[1])
  return [...new Set(flags)].sort()
}

/** Flags listed in the fenced block under `## Options`.
 *
 *  Only the flag column is read — the description column mentions `restore:`
 *  and `login:` and would otherwise contribute noise — and only lines that
 *  start with a dash, so a wrapped description line is skipped. */
function documentedFlags(): string[] {
  const block = /## Options\s*\n+```\n([\s\S]*?)```/.exec(README)
  if (!block) throw new Error('README has no fenced block under "## Options"')
  const flags: string[] = []
  for (const line of block[1].split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('-')) continue
    const column = trimmed.split(/ {2,}/)[0]
    for (const m of column.matchAll(/(--?[a-z][\w-]*)/g)) flags.push(m[1])
  }
  return [...new Set(flags)].sort()
}

/** Flags the parser matches, read from its own switch.
 *
 *  `case '-'` is excluded: a bare dash is a positional (stdin), not a flag. */
function parsedFlags(): string[] {
  const flags: string[] = []
  for (const m of ARGS_SOURCE.matchAll(/case '(--?[a-z][\w-]*)':/g)) flags.push(m[1])
  return [...new Set(flags)].sort()
}

describe('the README Options block and the argument parser', () => {
  it('documents every flag the parser accepts', () => {
    // Asked of the whole README, not just the options list, for the reason
    // `mentionedFlags` gives. The opposite direction below is asked only of the
    // options list, where `npm install -g` in an install snippet cannot be
    // mistaken for a flag of ours.
    const mentioned = mentionedFlags()
    const undocumented = parsedFlags().filter((f) => !mentioned.includes(f))
    expect(
      undocumented,
      `these flags work but are named nowhere in the README: ${undocumented.join(', ')}`
    ).toEqual([])
  })

  it('never documents a flag the parser would reject', () => {
    // The direction that produced `options.style`: the code moved on and the
    // README kept promising. Checked against the parser at runtime rather than
    // against its source, so a flag deleted from the switch fails here even if
    // the string survives somewhere else in the file.
    const rejected = documentedFlags().filter((flag) => {
      try {
        // A value-taking flag throws "requires a value" instead, which is the
        // parser confirming it knows the flag.
        parseArgs([flag])
        return false
      } catch (err) {
        return err instanceof UsageError && err.message.includes('unknown flag')
      }
    })
    expect(
      rejected,
      `the README lists ${rejected.join(', ')}, which the parser rejects as unknown`
    ).toEqual([])
  })
})
