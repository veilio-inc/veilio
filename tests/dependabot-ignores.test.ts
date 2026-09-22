import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Does the TypeScript hold actually cover the repository?
 *
 * TypeScript 7 cannot install here: @typescript-eslint/eslint-plugin peers on
 * typescript ">=4.8.4 <6.1.0", and 8.70.1 - the latest published release -
 * still does, so `npm ci` ends in ERESOLVE before a single test runs. Holding
 * the major is what lets every other update in a group keep flowing.
 *
 * The hold was added to the root npm entry and only the root npm entry. A
 * dependabot `ignore` is scoped to the entry it sits in, not to the repository,
 * and packages/engine has an entry of its own - so Dependabot raised
 * typescript ^7.0.2 there within minutes (#54) and it failed exactly the way
 * the root group had. packages/engine is a workspace, so its manifest feeds
 * the root tree and takes the same ERESOLVE, even though nothing in that
 * directory imports eslint.
 *
 * One missed entry is not a thing to remember. This is the rule.
 *
 * When typescript-eslint publishes a release whose typescript peer admits 7,
 * delete this test in the same change that lifts both ignores - its whole
 * subject will have stopped existing.
 *
 * Paths resolve from the vitest root.
 */

const CONFIG = '.github/dependabot.yml'

interface Entry {
  ecosystem: string
  directory: string
  body: string
}

/**
 * Split the `updates:` list into one blob per entry.
 *
 * Deliberately not a YAML parse. The thing being checked is a hand-edited
 * policy file, and a parser would need a dependency this repo does not have -
 * while the question ("does each npm entry contain this ignore") is answerable
 * from the text of each entry.
 */
function npmEntries(): Entry[] {
  const text = readFileSync(CONFIG, 'utf8')
  // Entries start at `  - package-ecosystem:` at exactly two spaces of indent.
  const starts: number[] = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (/^ {2}- package-ecosystem:/.test(line)) starts.push(i)
  })
  expect(starts.length, 'no update entries found - the config shape changed').toBeGreaterThan(0)

  return starts
    .map((start, n) => {
      const end = starts[n + 1] ?? lines.length
      const body = lines.slice(start, end).join('\n')
      return {
        ecosystem: (/package-ecosystem:\s*(\S+)/.exec(body)?.[1] ?? '').replace(/['"]/g, ''),
        directory: (/directory:\s*(\S+)/.exec(body)?.[1] ?? '').replace(/['"]/g, ''),
        body,
      }
    })
    .filter((e) => e.ecosystem === 'npm')
}

describe('the TypeScript hold covers every npm entry', () => {
  it('finds more than one npm entry, so a single-entry repo cannot pass vacuously', () => {
    // If this ever drops to one, the bug this test exists for is no longer
    // reachable - but so is the test, and a silent pass is worse than a
    // deleted one.
    expect(npmEntries().length).toBeGreaterThanOrEqual(2)
  })

  it.each(npmEntries().map((e) => [e.directory, e] as const))(
    'the npm entry for %s ignores the typescript major',
    (directory, entry) => {
      expect(
        entry.body,
        `the npm entry for ${directory} has no ignore list; Dependabot will raise ` +
          'typescript 7 against it and the PR will fail on npm ci'
      ).toMatch(/^\s*ignore:/m)
      expect(entry.body).toMatch(/-\s*dependency-name:\s*typescript\b/)
      expect(entry.body).toMatch(/version-update:semver-major/)
    }
  )
})
