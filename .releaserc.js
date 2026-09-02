import conventionalCommits from 'conventional-changelog-conventionalcommits'

// This file is JavaScript rather than JSON for one reason: the changelog needs a
// `transform` function to filter by scope, and JSON cannot hold one. See
// `engineOnlyWriter` below.

/** Changelog sections. Anything `hidden` still releases if its rule says so —
 *  this only controls what a reader sees. */
const TYPES = [
  { type: 'feat', section: 'Features' },
  { type: 'fix', section: 'Fixes' },
  { type: 'perf', section: 'Performance' },
  { type: 'refactor', section: 'Refactoring' },
  { type: 'build', section: 'Build' },
  { type: 'revert', section: 'Reverts' },
  { type: 'docs', hidden: true },
  { type: 'style', hidden: true },
  { type: 'test', hidden: true },
  { type: 'ci', hidden: true },
  { type: 'chore', hidden: true },
]

/** Only `engine`-scoped commits release a version.
 *
 *  The commit analyzer reads commit messages and never file paths, so `pkgRoot`
 *  scopes where npm publishes from but not what counts as a change. Without the
 *  scope gate any releasing type bumped the engine, and a `feat(ui)` published a
 *  new version over byte-identical engine code.
 *
 *  The leading catch-all is load-bearing: when no rule matches, the analyzer
 *  falls back to the preset's own defaults, which release on bare `feat` and
 *  `fix`. A rule has to match and return `false` to stop that.
 *
 *  Reverts need both spellings. `git revert` writes a header that does not parse
 *  as a conventional commit, so it carries no scope at all and has to be matched
 *  on the reverted subject; a hand-written `revert(engine):` matches on scope.
 *
 *  `[skip release]` stays last because the analyzer takes the highest release
 *  type of every matching rule, and `false` only outranks the others from there.
 *  It cannot hold back a breaking change in any case — rule scanning stops as
 *  soon as it reaches `major`. */
/** Scopes that mean "this is engine code".
 *
 *  `engine` is the convention and new work should use it. `secrets` is here
 *  because two commits used it before the rule was written down — 001-b1's
 *  re-grading and 003-b2's regulated-identifier detection, both of which are
 *  `packages/engine/src/secrets.ts` and both of which ship to npm. Every commit
 *  ever written under either scope touches `packages/engine/`; no `ui`, `crypto`
 *  or `docker` commit ever has.
 *
 *  Leaving `secrets` out was not cosmetic. The gate below governs the changelog
 *  as well as the version, so 1.3.0 would have shipped new IBAN, payment-card
 *  and PESEL detection and a re-graded severity scale under release notes that
 *  mentioned neither — a consumer reading them would have had no idea the scan
 *  had changed. And on its own, a `feat(secrets)` would not have released at
 *  all. */
const ENGINE_SCOPES = ['engine', 'secrets']

const releaseRules = [
  { release: false },
  ...ENGINE_SCOPES.flatMap((scope) => [
    { breaking: true, scope, release: 'major' },
    { type: 'revert', scope, release: 'patch' },
    { type: 'feat', scope, release: 'minor' },
    { type: 'fix', scope, release: 'patch' },
    { type: 'perf', scope, release: 'patch' },
    { type: 'refactor', scope, release: 'patch' },
    { type: 'build', scope, release: 'patch' },
  ]),
  { revert: true, header: '*\\(engine\\)*', release: 'patch' },
  { subject: '*\\[skip release\\]*', release: false },
  { body: '*\\[skip release\\]*', release: false },
]

/** Keep non-engine commits out of the engine's changelog.
 *
 *  `releaseRules` decides the version only. The notes are produced by a separate
 *  plugin that ignores those rules entirely, so without this the package
 *  published to npm shipped a CHANGELOG crediting it with UI and Docker work it
 *  does not contain.
 *
 *  The notes generator merges `writerOpts` shallowly over the preset's own, so a
 *  `transform` here replaces the preset's rather than running after it. Load the
 *  preset with the same `types` the plugin will and delegate, so section
 *  mapping, short hashes and compare links stay exactly as the preset builds
 *  them; the only addition is the scope gate in front.
 *
 *  An engine commit marked `[skip release]` is still listed. It did not warrant
 *  a release on its own, but its code ships in whichever release does. */
const { writer } = await conventionalCommits({ types: TYPES })

const engineOnlyWriter = {
  transform(commit, context) {
    if (!ENGINE_SCOPES.includes(commit.scope)) return false
    return writer.transform(commit, context)
  },
}

export default {
  branches: ['main'],
  tagFormat: 'engine-v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits', releaseRules }],
    [
      '@semantic-release/release-notes-generator',
      {
        preset: 'conventionalcommits',
        presetConfig: { types: TYPES },
        writerOpts: engineOnlyWriter,
      },
    ],
    [
      '@semantic-release/changelog',
      {
        changelogFile: 'packages/engine/CHANGELOG.md',
        changelogTitle: '# Changelog',
      },
    ],
    ['@semantic-release/npm', { pkgRoot: 'packages/engine' }],
    [
      '@semantic-release/git',
      {
        assets: [
          'packages/engine/package.json',
          'packages/engine/package-lock.json',
          'packages/engine/CHANGELOG.md',
        ],
        message: 'chore(release): engine ${nextRelease.version} [skip ci]',
      },
    ],
    ['@semantic-release/github', { successComment: false, failComment: false }],
  ],
}
