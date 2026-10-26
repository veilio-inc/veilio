import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args'

// `-f` is documented as `--force` in the README and in --help. Since 0.5.4 it
// set `--team` instead, so `veilio maps pull <id> -f` asked for a team map and
// did not force anything.
describe('short flags', () => {
  it('-f is --force, not --team', () => {
    const short = parseArgs(['maps', 'pull', 'x', '-f'])
    expect(short.force).toBe(true)
    expect(short.team).toBeFalsy()
    expect(short).toEqual(parseArgs(['maps', 'pull', 'x', '--force']))
  })

  it('--team still sets team only', () => {
    const team = parseArgs(['maps', 'push', '--team'])
    expect(team.team).toBe(true)
    expect(team.force).toBeFalsy()
  })
})
