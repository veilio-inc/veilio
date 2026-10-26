import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The engine CHANGELOG's newest entry is the version the engine manifest names.
 *
 * semantic-release writes CHANGELOG.md only inside the release runner, before
 * `npm pack`. It no longer commits the file, because that meant pushing to a
 * protected `main` (2f1fa5b). So the repository copy stopped at 1.2.0 while
 * npm reached 1.11.0, and every published tarball carried that stale file
 * with only its own release on top: the 1.11.0 package went from 1.11.0
 * straight to 1.2.0.
 *
 * CI's "Engine version matches what is published" step already makes
 * packages/engine/package.json follow npm. This test makes the CHANGELOG
 * follow package.json. So after an engine release, one sync PR moves both:
 * the version, and the new entry copied from the GitHub Release. Bump the
 * version without the entry and this fails. See docs/PUBLISHING.md, "After an
 * engine release".
 */
const ENGINE = resolve(import.meta.dirname, '..', 'packages', 'engine')

/** The newest version heading. semantic-release writes `## [1.2.3](compare…)`;
 *  the hand-written first release is `## 1.0.0`. A `##` heading that names no
 *  version (a note, such as the dated record of what the file left out) is
 *  skipped. */
function topChangelogVersion(changelog: string): string | null {
  for (const line of changelog.split('\n')) {
    const m = /^## \[?(\d+\.\d+\.\d+)\]?(?:[\s(]|$)/.exec(line)
    if (m) return m[1]
  }
  return null
}

describe('the engine CHANGELOG', () => {
  const version = (
    JSON.parse(readFileSync(resolve(ENGINE, 'package.json'), 'utf8')) as { version: string }
  ).version
  const changelog = readFileSync(resolve(ENGINE, 'CHANGELOG.md'), 'utf8')

  it('has, as its newest entry, the version packages/engine/package.json names', () => {
    expect(
      topChangelogVersion(changelog),
      `packages/engine/package.json is ${version}, but the newest entry in packages/engine/CHANGELOG.md is not. ` +
        `Copy the ${version} notes from the GitHub Release engine-v${version} into the CHANGELOG, ` +
        `in the same PR that syncs the version (docs/PUBLISHING.md, "After an engine release").`
    ).toBe(version)
  })

  it('has one entry for that version, not two', () => {
    // A sync PR that pastes the release over an entry already there would
    // still pass the check above.
    const headings = changelog
      .split('\n')
      .filter((l) => new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?(?:[\\s(]|$)`).test(l))
    expect(headings).toHaveLength(1)
  })

  it('starts with a version entry, so a note cannot end up between releases', () => {
    // semantic-release adds each release directly under `# Changelog`. A note
    // placed above the entries would be pushed down between two releases, so
    // notes go at the end of the file.
    const first = changelog.split('\n').find((l) => l.startsWith('## '))
    expect(first && topChangelogVersion(first), `first heading: ${first}`).toBe(version)
  })

  it('reads the newest version, skipping a heading that names none', () => {
    // The parser is checked on its own, so that a format change cannot make
    // it return null on a real file and the test above pass for the wrong
    // reason.
    expect(
      topChangelogVersion('# Changelog\n\n## Record\n\n## [1.12.0](x) (d)\n\n## 1.0.0\n')
    ).toBe('1.12.0')
    expect(topChangelogVersion('# Changelog\n\n## 1.0.0\n')).toBe('1.0.0')
    expect(topChangelogVersion('# Changelog\n\n## Record of 2.0.0-ish things\n')).toBeNull()
  })
})
