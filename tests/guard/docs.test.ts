import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Spec 083 US4 (constitution I): the guard's documents state no number or
// platform claim the plugin contradicts.
const PLUGIN = join(__dirname, '../../plugins/veilio-guard')
const read = (f: string) => readFileSync(join(PLUGIN, f), 'utf8')
const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
]

describe('guard documents', () => {
  it('the README states no userConfig count other than plugin.json has', () => {
    const keys = Object.keys(JSON.parse(read('.claude-plugin/plugin.json')).userConfig ?? {})
    const said = [
      ...read('README.md').matchAll(
        /\b(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\b\W{0,3}userConfig/gi
      ),
    ].map((m) => (/^\d+$/.test(m[1]) ? Number(m[1]) : WORDS.indexOf(m[1].toLowerCase())))
    for (const n of said) expect(n).toBe(keys.length)
    const both = /\bBoth options\b/.test(read('README.md'))
    expect(both && keys.length !== 2).toBe(false)
  })

  it('COVERAGE.md does not call Windows untested while it describes a Windows session', () => {
    const coverage = read('COVERAGE.md')
    const covered = coverage.slice(
      coverage.indexOf('## Covered'),
      coverage.indexOf('## Not covered')
    )
    const session = /Windows 11|On Windows, one session/.test(covered)
    expect(session && /Windows is untested/.test(coverage)).toBe(false)
  })
})
