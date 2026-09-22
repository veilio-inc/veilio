import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Can the tools publish pipeline still run?
 *
 * `publish-tools.yml` fires on a push to main behind a `paths` filter, and
 * nothing else. No pull request can exercise it, so a change that breaks
 * publishing is green by construction, and it breaks at the one moment nobody
 * is watching - after the merge, on the way to npm.
 *
 * It was in fact broken, in two ways at once, for as long as the action had
 * been pinned at v2.1.2:
 *
 *   - `@changesets/cli` was 2.31.0. The action's v2 line refuses CLI v2
 *     outright ("Changesets CLI v2 is not supported; use Changesets action v1
 *     instead"), so the step aborted.
 *   - the inputs were still the v1 spellings - version, publish, title, commit.
 *     v2 reads version-script, publish-script, pr-title and commit-message, and
 *     an unrecognised input only WARNS. So `publish` fell back to its default,
 *     and a run that got past the first problem would have published nothing
 *     while reporting success.
 *
 * Veilio Cloud learned the same lesson the expensive way: Dependabot raised the
 * action major there on a green PR, it was merged, and the release broke on the
 * next push to main. This test is that repo's guard, ported.
 *
 * Paths resolve from the vitest root.
 */

const WORKFLOW = '.github/workflows/publish-tools.yml'
const MANIFEST = 'package.json'

/** The `uses:` line for changesets/action, with its pinned SHA and version comment. */
function changesetsActionRef(): string {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const line = workflow.split('\n').find((l) => l.includes('uses: changesets/action@'))
  // A missing line is a failure, not a skip: this test exists to notice the
  // workflow changing, and losing the step entirely is a change.
  expect(line, `${WORKFLOW} no longer uses changesets/action`).toBeDefined()
  return (line as string).trim()
}

/** Major version from the `# vX.Y.Z` comment beside the pinned SHA. */
function actionMajor(): number {
  const ref = changesetsActionRef()
  const version = /#\s*v(\d+)\.\d+\.\d+/.exec(ref)
  // The SHA alone says nothing a reader can check. The comment is how anyone
  // knows what is pinned, and this test is one of the readers.
  expect(version, `no "# vX.Y.Z" comment beside the pinned SHA: ${ref}`).not.toBeNull()
  return Number((version as RegExpExecArray)[1])
}

/** Major version of the Changesets CLI this repo actually installs. */
function cliMajor(): number {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    devDependencies?: Record<string, string>
    dependencies?: Record<string, string>
  }
  const spec =
    manifest.devDependencies?.['@changesets/cli'] ?? manifest.dependencies?.['@changesets/cli']
  expect(spec, '@changesets/cli is not in the root manifest').toBeDefined()
  const major = /(\d+)\./.exec(spec as string)
  expect(major, `cannot read a major version out of "${spec}"`).not.toBeNull()
  return Number((major as RegExpExecArray)[1])
}

/** The input keys the `with:` block passes to the action. */
function actionInputs(): string[] {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n')
  const usesAt = lines.findIndex((l) => l.includes('uses: changesets/action@'))
  const withAt = lines.findIndex((l, i) => i > usesAt && l.trim() === 'with:')
  expect(withAt, 'the changesets step passes no inputs at all').toBeGreaterThan(usesAt)

  const indent = (lines[withAt].match(/^\s*/) as RegExpMatchArray)[0].length
  const keys: string[] = []
  for (let i = withAt + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const lineIndent = (line.match(/^\s*/) as RegExpMatchArray)[0].length
    if (lineIndent <= indent) break
    const key = /^\s*([a-z-]+):/.exec(line)
    if (key) keys.push(key[1])
  }
  return keys
}

/** v1 input spellings and their v2 replacements. */
const RENAMED_IN_V2: Record<string, string> = {
  version: 'version-script',
  publish: 'publish-script',
  commit: 'commit-message',
  title: 'pr-title',
}

describe('the tools publish workflow can actually publish', () => {
  it('pins changesets/action to a full SHA, not a floating tag', () => {
    // This workflow publishes to npm with provenance. A tag is mutable by
    // whoever owns the action.
    expect(changesetsActionRef()).toMatch(/uses: changesets\/action@[0-9a-f]{40}\b/)
  })

  it('runs an action major that supports the installed Changesets CLI', () => {
    const action = actionMajor()
    const cli = cliMajor()
    if (action >= 2) {
      expect(
        cli,
        `changesets/action v${action} requires Changesets CLI v3; this repo installs v${cli}. ` +
          'Bump @changesets/cli first, in the same change, or hold the action at v1.'
      ).toBeGreaterThanOrEqual(3)
    } else {
      expect(
        cli,
        `changesets/action v${action} is the CLI v2 line; this repo installs CLI v${cli}, ` +
          'so the action can move up in the same change.'
      ).toBeLessThanOrEqual(2)
    }
  })

  it('passes input names the pinned action major actually reads', () => {
    const action = actionMajor()
    const inputs = actionInputs()
    expect(inputs.length, 'no inputs parsed - the with: block shape changed').toBeGreaterThan(0)

    if (action >= 2) {
      for (const [v1Name, v2Name] of Object.entries(RENAMED_IN_V2)) {
        expect(
          inputs,
          `"${v1Name}" is the v1 spelling; changesets/action v${action} reads "${v2Name}" ` +
            'and ignores this one with only a warning, so the step succeeds having done nothing.'
        ).not.toContain(v1Name)
      }
      // The two that carry the release itself.
      expect(inputs).toContain('version-script')
      expect(inputs).toContain('publish-script')
    } else {
      for (const v2Name of Object.values(RENAMED_IN_V2)) {
        expect(
          inputs,
          `"${v2Name}" is the v2 spelling; changesets/action v${action} does not read it.`
        ).not.toContain(v2Name)
      }
      expect(inputs).toContain('version')
      expect(inputs).toContain('publish')
    }
  })
})
