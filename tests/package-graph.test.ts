import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Would a stranger be able to install what we publish?
 *
 * A workspace resolves `@veilio-inc/shared` to a symlink on this machine. A
 * registry resolves it to a 404, because that package is private and never goes
 * anywhere. So a manifest can be simultaneously correct in development and
 * broken for every person who has ever run `npm install` — and nothing in the
 * repo notices, because the repo is the one place the lie holds.
 *
 * That is not hypothetical. `@veilio-inc/cli` and `@veilio-inc/mcp` both
 * declared a dependency on a private package and imported nothing at all from
 * it. The GitHub Action in `packages/cli/action.yml` runs
 * `npx --yes @veilio-inc/cli@<version> scan`, so the first person to use the CI
 * integration would have been the one to find out.
 *
 * This file came with the CLI and the MCP server when they moved here from the
 * closed Cloud repository, where it lived beside a private `@veilio-inc/shared`
 * that both of them wrongly depended on. Every package in THIS repository is
 * meant for the registry, so the rule it enforces currently has nothing to
 * refuse — which is the argument for keeping it, not for deleting it. The
 * repository it was written for is exactly the repository where nobody thought
 * the rule was needed.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..')

interface Manifest {
  name: string
  private?: boolean
  license?: string
  files?: string[]
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

interface WorkspacePackage {
  dir: string
  manifest: Manifest
  /** Everything the package's own source and tests actually import. */
  imported: ReadonlySet<string>
}

/** `@scope/name/sub/path` → `@scope/name`; `pkg/sub` → `pkg`. Relative paths → null. */
function packageOfSpecifier(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null
  if (specifier.startsWith('node:')) return null
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function importedPackages(dir: string): Set<string> {
  const found = new Set<string>()
  // Matches `from '…'`, `import '…'`, `require('…')` and `import('…')`. Deliberately
  // textual: a resolver would need the build to have run, and this must hold for a
  // package whose dist/ was never produced.
  const specifier = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g

  function walk(absolute: string): void {
    for (const entry of readdirSync(absolute)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const child = join(absolute, entry)
      if (statSync(child).isDirectory()) {
        walk(child)
        continue
      }
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) continue
      const text = readFileSync(child, 'utf8')
      for (const match of text.matchAll(specifier)) {
        const pkg = packageOfSpecifier(match[1])
        if (pkg) found.add(pkg)
      }
    }
  }

  for (const sub of ['src', 'tests']) {
    const path = join(dir, sub)
    try {
      if (statSync(path).isDirectory()) walk(path)
    } catch {
      // A package need not have both.
    }
  }
  return found
}

/** Derived from the directory listing, never enumerated — a package added
 *  tomorrow is checked because it exists, not because somebody listed it. */
function workspacePackages(): WorkspacePackage[] {
  const packagesDir = join(REPO_ROOT, 'packages')
  const found: WorkspacePackage[] = []
  for (const entry of readdirSync(packagesDir)) {
    const dir = join(packagesDir, entry)
    let manifest: Manifest
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
    } catch {
      continue
    }
    found.push({ dir, manifest, imported: importedPackages(dir) })
  }
  return found
}

const PACKAGES = workspacePackages()
const BY_NAME = new Map(PACKAGES.map((p) => [p.manifest.name, p]))

function isPublishable(p: WorkspacePackage): boolean {
  return p.manifest.private !== true
}

function workspaceDependencies(p: WorkspacePackage): string[] {
  return Object.keys(p.manifest.dependencies ?? {}).filter((name) => BY_NAME.has(name))
}

/**
 * The rule, as a function, so it can be exercised against cases the repo does
 * not currently contain.
 *
 * Returns the dependency names that would 404 for anyone outside this checkout.
 */
export function unresolvableForStrangers(
  manifests: ReadonlyMap<string, { private?: boolean }>,
  self: { name: string; private?: boolean; dependencies?: Record<string, string> }
): string[] {
  if (self.private === true) return []
  return Object.keys(self.dependencies ?? {}).filter((dep) => manifests.get(dep)?.private === true)
}

describe('the workspace package graph', () => {
  it('finds every package under packages/, derived from the directory', () => {
    expect(PACKAGES.length).toBeGreaterThanOrEqual(3)
    for (const p of PACKAGES) {
      expect(p.manifest.name).toMatch(/^@veilio-inc\//)
    }
  })

  it('claims only the npm scope the company owns', () => {
    // `@veilio` is not ours. A package under it cannot be published at all, and
    // the CLI's GitHub Action installs itself by name from the registry.
    for (const p of PACKAGES) {
      expect(p.manifest.name.startsWith('@veilio/')).toBe(false)
    }
  })

  it('declares no workspace dependency the package does not import', () => {
    // An unused dependency on a PRIVATE package is the one that bites: it costs
    // nothing here and makes the package uninstallable everywhere else. Both
    // `cli` and `mcp` once carried exactly that, on a private package in the
    // repository they came from.
    const unused: string[] = []
    for (const p of PACKAGES) {
      for (const dep of workspaceDependencies(p)) {
        if (!p.imported.has(dep)) unused.push(`${p.manifest.name} → ${dep}`)
      }
    }
    expect(unused).toEqual([])
  })

  it('pins workspace dependencies to a range that means something off this machine', () => {
    // `*` resolves to the symlink here and to "any version ever published"
    // for everybody else. Private packages are exempt: they are never resolved
    // from a registry, so the range is genuinely unused.
    const wildcards: string[] = []
    for (const p of PACKAGES) {
      if (!isPublishable(p)) continue
      for (const dep of workspaceDependencies(p)) {
        const range = p.manifest.dependencies![dep]
        if (range === '*' || range === '') wildcards.push(`${p.manifest.name} → ${dep}@${range}`)
      }
    }
    expect(wildcards).toEqual([])
  })

  it('never lets a published package depend on an unpublished one', () => {
    const broken = PACKAGES.flatMap((p) =>
      unresolvableForStrangers(
        new Map(PACKAGES.map((q) => [q.manifest.name, q.manifest])),
        p.manifest
      ).map((dep) => `${p.manifest.name} → ${dep}`)
    )
    expect(broken).toEqual([])
  })

  it('applies that rule to a case the repo does not currently contain', () => {
    // `cli` and `mcp` are still `private: true` pending their first release, so
    // the assertion above is satisfied by an empty set — it proves nothing on
    // its own, and would go on proving nothing on the day somebody flips one.
    // This exercises the rule directly, so the guard is real before it is
    // needed rather than after. `@veilio-inc/internal` is a package this
    // repository does not have, on purpose: the case being covered is the one
    // the tree cannot currently produce.
    const manifests = new Map([
      ['@veilio-inc/cli', { private: false }],
      ['@veilio-inc/internal', { private: true }],
      ['@veilio-inc/engine', { private: false }],
    ])

    expect(
      unresolvableForStrangers(manifests, {
        name: '@veilio-inc/cli',
        private: false,
        dependencies: { '@veilio-inc/internal': '*', '@veilio-inc/engine': '^1.3.0' },
      })
    ).toEqual(['@veilio-inc/internal'])

    // A private package may depend on anything: nobody installs it from a registry.
    expect(
      unresolvableForStrangers(manifests, {
        name: '@veilio-inc/tooling',
        private: true,
        dependencies: { '@veilio-inc/internal': '*' },
      })
    ).toEqual([])

    // And a published package on published dependencies is fine.
    expect(
      unresolvableForStrangers(manifests, {
        name: '@veilio-inc/cli',
        private: false,
        dependencies: { '@veilio-inc/engine': '^1.3.0' },
      })
    ).toEqual([])
  })
})

describe('what the READMEs tell a reader to install', () => {
  /** Every `npm install <pkg>` / `npm i <pkg>` line in a package README. */
  function installTargets(dir: string): string[] {
    let text: string
    try {
      text = readFileSync(join(dir, 'README.md'), 'utf8')
    } catch {
      return []
    }
    // Two shapes, because a README promises a package in more than one way and
    // matching only the first left the worst case invisible.
    //
    // `npm install @scope/name` is the obvious one. The other is a fenced block
    // that runs the package through npx — and packages/mcp/README.md is exactly
    // that: an agent config where `"command": "npx"` and `"@veilio-inc/mcp"`
    // sit on DIFFERENT LINES of a JSON object. It says `npm install` nowhere, so
    // a line-oriented match read it as advertising nothing, and the one README
    // whose entire install section was a 404 was the one this could not see.
    //
    // So a fenced block mentioning npx implicates every scoped package named
    // inside it. Scoped to code fences on purpose: prose saying "the CLI is
    // published as @veilio-inc/cli" is a statement, not an instruction, and
    // flagging it would push people to stop naming their own packages.
    const targets: string[] = []
    for (const m of text.matchAll(/npm (?:install|i) (?:-g )?(@[a-z0-9-]+\/[a-z0-9-]+)/g)) {
      targets.push(m[1])
    }
    for (const fence of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
      const body = fence[1]
      if (!/\bnpx\b/.test(body)) continue
      for (const m of body.matchAll(/(@[a-z0-9-]+\/[a-z0-9-]+)/g)) targets.push(m[1])
    }
    return targets
  }

  it('never advertises a package that does not publish', () => {
    // A private package's README once opened with `npm install` on its own name
    // and a quick-start importing from it. The install 404s, and the import
    // resolved to nothing even inside the monorepo. A README is the one file
    // nobody typechecks, which is exactly why it kept saying it.
    //
    // Live again right now for a different reason: `cli` and `mcp` are still
    // `private: true` until their first release, so an install line added to
    // either README before the flip is a promise the registry cannot keep.
    const offenders: string[] = []
    for (const p of PACKAGES) {
      for (const target of installTargets(p.dir)) {
        const workspace = BY_NAME.get(target)
        if (workspace && !isPublishable(workspace)) {
          offenders.push(
            `${p.manifest.name}/README.md tells the reader to obtain ${target}, which is private`
          )
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('the licence each package ships under', () => {
  function licenseFileOf(dir: string): string | null {
    try {
      return readFileSync(join(dir, 'LICENSE'), 'utf8')
    } catch {
      return null
    }
  }

  it('ships the licence text whenever the manifest points at a file', () => {
    // `SEE LICENSE IN LICENSE` with no LICENSE in the tarball is a package whose
    // terms nobody can read — npm shows the string and the file is not there.
    for (const p of PACKAGES) {
      if (p.manifest.license !== 'SEE LICENSE IN LICENSE') continue
      expect(p.manifest.files ?? [], `${p.manifest.name} must ship LICENSE`).toContain('LICENSE')
      expect(licenseFileOf(p.dir), `${p.manifest.name} has no LICENSE file`).not.toBeNull()
    }
  })

  it('never lists a licence file a package does not have', () => {
    const missing = PACKAGES.filter(
      (p) => (p.manifest.files ?? []).includes('LICENSE') && licenseFileOf(p.dir) === null
    ).map((p) => p.manifest.name)
    expect(missing).toEqual([])
  })

  it('never ships a grant from a package that declares UNLICENSED', () => {
    // `packages/shared` did exactly this: `license: UNLICENSED`, `private: true`,
    // and an MIT LICENSE in `files` — left over from when it was going to be the
    // published engine. A stray `npm pack` would have shipped a permissive grant
    // for the Cloud product taxonomy, over a manifest that denies one.
    const contradictions = PACKAGES.filter(
      (p) => p.manifest.license === 'UNLICENSED' && licenseFileOf(p.dir) !== null
    ).map((p) => p.manifest.name)
    expect(contradictions).toEqual([])
  })

  it('gives the public tools the same terms as the engine they wrap', () => {
    // The CLI and the MCP server are free adoption tools that wrap
    // @veilio-inc/engine, and packages/cli/action.yml tells the world to run the
    // CLI with `npx`. They carry the Community License, the same terms the
    // engine ships under — asserted per package rather than inherited from the
    // repository root, because that inheritance is exactly what stopped being
    // true when they lived in the closed repository, and a licence that is
    // correct only because of where the directory happens to sit is not a
    // licence anyone can rely on.
    for (const name of ['@veilio-inc/cli', '@veilio-inc/mcp']) {
      const p = BY_NAME.get(name)
      expect(p, `${name} not found`).toBeDefined()
      expect(p!.manifest.license).toBe('SEE LICENSE IN LICENSE')
      expect(licenseFileOf(p!.dir)).toMatch(/Veilio Community License/)
    }
  })
})

describe('the engine range the tools declare', () => {
  /**
   * Two release tools share this repository. semantic-release owns
   * `@veilio-inc/engine` and derives its version from the `engine-v*` tags;
   * Changesets owns the CLI and the MCP server. Neither knows about the other,
   * and the edge between them is a semver range in two manifests.
   *
   * The failure is silent in the direction that matters. npm links a workspace
   * package only when its version satisfies the declared range. Let
   * `packages/engine/package.json` fall behind what the CLI asks for and npm
   * stops linking it — it installs a REGISTRY copy instead, without a word, and
   * every CLI and MCP test from then on runs against a published engine while
   * the engine source sitting in the same tree goes untested by them. Both
   * suites stay green. The tree is the one place the mismatch is invisible.
   *
   * That drift is not hypothetical here: `@semantic-release/git` was removed
   * from the release so it would stop pushing to a protected branch, which
   * means the version bump is no longer committed back and this manifest only
   * moves when a person moves it.
   */
  const ENGINE = '@veilio-inc/engine'

  /** `^1.3.0` → [1, 3, 0]. Anything else → null. */
  function caretParts(range: string): [number, number, number] | null {
    const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }

  function satisfiesCaret(version: string, range: string): boolean {
    const want = caretParts(range)
    const have = caretParts(`^${version}`)
    if (!want || !have) return false
    if (have[0] !== want[0]) return false
    if (have[1] !== want[1]) return have[1] > want[1]
    return have[2] >= want[2]
  }

  const engineVersion = BY_NAME.get(ENGINE)!.manifest as unknown as { version: string }
  const dependants = PACKAGES.filter((p) => (p.manifest.dependencies ?? {})[ENGINE])

  it('is declared by both tools, as a caret range', () => {
    // A floor with no ceiling (`*`, `>=1.3.0`) would let a future major land on
    // a user's machine unannounced; an exact pin would refuse the patch releases
    // that exist to be taken.
    expect(dependants.map((p) => p.manifest.name).sort()).toEqual([
      '@veilio-inc/cli',
      '@veilio-inc/mcp',
    ])
    for (const p of dependants) {
      const range = p.manifest.dependencies![ENGINE]
      expect(caretParts(range), `${p.manifest.name} declares ${ENGINE}@${range}`).not.toBeNull()
    }
  })

  it('is satisfied by the engine version in this tree', () => {
    const drifted = dependants
      .filter((p) => !satisfiesCaret(engineVersion.version, p.manifest.dependencies![ENGINE]))
      .map((p) => `${p.manifest.name} wants ${p.manifest.dependencies![ENGINE]}`)

    expect(
      drifted,
      `packages/engine is ${engineVersion.version}. Anything it does not satisfy is ` +
        `resolved from the registry instead of this tree, silently.`
    ).toEqual([])
  })

  it('catches the drift it exists to catch', () => {
    // The assertion above passes on an empty list, which is what it will look
    // like on the day the check stops working. These are the two cases, stated
    // directly.
    expect(satisfiesCaret('1.3.0', '^1.3.0')).toBe(true)
    expect(satisfiesCaret('1.4.2', '^1.3.0')).toBe(true)
    expect(satisfiesCaret('1.2.0', '^1.3.0')).toBe(false) // engine behind: the silent one
    expect(satisfiesCaret('2.0.0', '^1.3.0')).toBe(false) // engine ahead by a major
    expect(satisfiesCaret('1.3.0', '*')).toBe(false) // not a caret range at all
  })

  /**
   * The other direction, which the check above deliberately permits.
   *
   * `satisfiesCaret('1.4.0', '^1.3.0')` is TRUE — a caret range accepts a newer
   * minor, so nothing above complains when the engine moves to 1.4.0 and the
   * two manifests keep asking for ^1.3.0. Nothing breaks in this repository
   * either: the workspace still links, both suites still run against the engine
   * in the tree.
   *
   * It breaks for somebody else. The tools are developed and tested against
   * 1.4.0 while promising to work with 1.3.0, so a user whose tree already
   * resolves 1.3.0 gets a CLI calling an API that is not there. The lie is in
   * the floor, and this repository is the one place it cannot be observed.
   *
   * Pinned at MINOR granularity on purpose. New APIs arrive in minors, so that
   * is exactly when the floor has to rise; patches are compatible by definition
   * and forcing a manifest edit — and therefore a CLI release — for every engine
   * patch would be churn with nothing behind it.
   *
   * This is the manual step the two-tool split costs, made loud. Changesets does
   * not know semantic-release moved the engine, so widening these ranges is a
   * human edit, and a human edit nobody is reminded to make is one that stops
   * happening. It fires at the moment the engine's own version field is being
   * edited by hand, which is the moment somebody is already in the file.
   */
  it('rises with the engine, instead of quietly promising an older one', () => {
    const engine = caretParts(`^${engineVersion.version}`)
    expect(engine, `engine version ${engineVersion.version} is not X.Y.Z`).not.toBeNull()

    const stale = dependants
      .filter((p) => {
        const floor = caretParts(p.manifest.dependencies![ENGINE])
        return !floor || floor[0] !== engine![0] || floor[1] !== engine![1]
      })
      .map((p) => `${p.manifest.name} declares ${p.manifest.dependencies![ENGINE]}`)

    expect(
      stale,
      `packages/engine is ${engineVersion.version}. A tool tested against it while ` +
        `declaring an older floor promises a user an engine it no longer runs on. ` +
        `Widen the range in the same commit that moves the engine's version.`
    ).toEqual([])
  })

  it('accepts a patch moving under it, and refuses a minor', () => {
    // The granularity, stated directly, because the assertion above passes on an
    // empty list and would go on passing if the comparison were dropped.
    const floorTracks = (engineVersion_: string, range: string): boolean => {
      const e = caretParts(`^${engineVersion_}`)
      const f = caretParts(range)
      return Boolean(e && f && f[0] === e[0] && f[1] === e[1])
    }
    expect(floorTracks('1.3.0', '^1.3.0')).toBe(true)
    expect(floorTracks('1.3.7', '^1.3.0')).toBe(true) // patch: compatible, no edit
    expect(floorTracks('1.4.0', '^1.3.0')).toBe(false) // minor: new APIs, floor must rise
    expect(floorTracks('2.0.0', '^1.3.0')).toBe(false) // major: certainly
    expect(floorTracks('1.3.0', '*')).toBe(false) // not a caret range at all
  })
})
