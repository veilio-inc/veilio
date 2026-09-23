import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'

/**
 * Does every lockfile still describe its own package.json?
 *
 * `npm ci` answers this for the lockfile it is run against, and refuses to
 * install when the two disagree:
 *
 *   npm error `npm ci` can only install packages when your package.json and
 *   package-lock.json are in sync.
 *
 * That check is free for the ROOT lockfile, because every CI job starts with
 * `npm ci` at the root. It is worth nothing for `packages/engine`, which keeps
 * a lockfile of its own - separate because semantic-release publishes from it -
 * and which no job in this repository installs from. Nothing looks at that file
 * until somebody publishes.
 *
 * So it drifted. #53 raised the engine's devDependency on vitest to ^5.0.1 and
 * regenerated the root lockfile, which is the one `npm install` at the root
 * touches; packages/engine/package-lock.json kept saying 4.1.10 and kept
 * declaring ^4.1.10. Everything stayed green. Dependabot noticed (#56) and it
 * was fixed there, but "a bot happened to look" is not a control - the same
 * drift on a Friday afternoon is a broken publish on Monday.
 *
 * Lockfiles are discovered rather than listed, so a third one added later is
 * covered on the day it appears.
 *
 * Paths resolve from the vitest root.
 */

const REPO_ROOT = process.cwd()
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next'])

interface Manifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

interface Lockfile {
  lockfileVersion?: number
  packages?: Record<string, Manifest & { version?: string }>
}

/** Every package-lock.json in the working tree, repo-relative. */
function findLockfiles(dir = REPO_ROOT, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let isDir: boolean
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue // a broken symlink is not a lockfile
    }
    if (isDir) findLockfiles(full, found)
    else if (entry === 'package-lock.json') found.push(relative(REPO_ROOT, full))
  }
  return found
}

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

const LOCKFILES = findLockfiles()

describe('every lockfile agrees with the package.json beside it', () => {
  it('finds the lockfiles, so a broken walk cannot pass vacuously', () => {
    // Two today: the root, and packages/engine. If this ever reads zero, the
    // discovery is broken and every assertion below would silently pass.
    expect(LOCKFILES.length).toBeGreaterThanOrEqual(2)
    expect(LOCKFILES).toContain('package-lock.json')
  })

  it.each(LOCKFILES)('%s declares what its package.json declares', (lockPath) => {
    const manifestPath = join(dirname(lockPath), 'package.json')
    expect(existsSync(join(REPO_ROOT, manifestPath)), `${lockPath} has no sibling package.json`).toBe(
      true
    )

    const lock = JSON.parse(readFileSync(join(REPO_ROOT, lockPath), 'utf8')) as Lockfile
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, manifestPath), 'utf8')) as Manifest

    // `packages[""]` is the lockfile's copy of its own root manifest. npm
    // compares exactly this when deciding whether the two are in sync.
    const mirrored = lock.packages?.['']
    expect(mirrored, `${lockPath} has no packages[""] entry - unexpected lockfile shape`).toBeDefined()

    for (const section of DEPENDENCY_SECTIONS) {
      expect(
        mirrored![section] ?? {},
        `${lockPath} records different ${section} than ${manifestPath}. ` +
          `Run \`npm install\` in ${dirname(lockPath) || '.'} and commit the lockfile - ` +
          '`npm ci` there would refuse to install.'
      ).toEqual(manifest[section] ?? {})
    }
  })

  it.each(LOCKFILES)('%s resolves versions its own ranges allow', (lockPath) => {
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, lockPath), 'utf8')) as Lockfile
    const declared = lock.packages?.['']

    let checked = 0
    for (const section of DEPENDENCY_SECTIONS) {
      // peerDependencies are not installed into this tree, so there is no
      // resolved version here to compare them against.
      if (section === 'peerDependencies') continue

      for (const [name, range] of Object.entries(declared?.[section] ?? {})) {
        const resolved = lock.packages?.[`node_modules/${name}`]?.version
        // A workspace link or an absent optional dependency has no version
        // here; that is not a mismatch.
        if (!resolved) continue

        const major = majorOf(range)
        if (major === null) continue // a form this check does not read, e.g. a URL or a tag

        checked++
        expect(
          majorOfVersion(resolved),
          `${lockPath}: ${name} is declared "${range}" but resolves to ${resolved}. ` +
            'The lockfile was regenerated against a different manifest than the one beside it.'
        ).toBe(major)
      }
    }

    // Deliberately not a `toBeGreaterThan(0)` on every lockfile - a package
    // with no dependencies is legitimate. But across ALL of them, finding
    // nothing to check means the matcher is broken, which the next case pins.
    expect(checked).toBeGreaterThanOrEqual(0)
  })

  it('checks a meaningful number of ranges overall', () => {
    // The guard against the loop above quietly reading nothing: between them
    // these lockfiles declare dozens of dependencies.
    let total = 0
    for (const lockPath of LOCKFILES) {
      const lock = JSON.parse(readFileSync(join(REPO_ROOT, lockPath), 'utf8')) as Lockfile
      const declared = lock.packages?.['']
      for (const section of DEPENDENCY_SECTIONS) {
        if (section === 'peerDependencies') continue
        for (const [name, range] of Object.entries(declared?.[section] ?? {})) {
          if (lock.packages?.[`node_modules/${name}`]?.version && majorOf(range) !== null) total++
        }
      }
    }
    expect(total).toBeGreaterThan(10)
  })
})

/**
 * Major version a range pins to, or null for a form this does not read.
 *
 * Hand-rolled rather than reaching for `semver`, which is only present here as
 * somebody else's transitive dependency - a test that breaks when an unrelated
 * package dedupes differently is worse than one that reads four characters of
 * a string. Every range in these manifests is `^x.y.z`, `~x.y.z` or exact.
 */
function majorOf(range: string): number | null {
  const match = /^[\^~]?(\d+)\./.exec(range.trim())
  return match ? Number(match[1]) : null
}

function majorOfVersion(version: string): number | null {
  const match = /^(\d+)\./.exec(version.trim())
  return match ? Number(match[1]) : null
}
