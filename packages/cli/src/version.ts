import { createRequire } from 'node:module'

/**
 * The package's own version.
 *
 * Read from package.json, not typed here: changesets bumps the manifest only,
 * so a literal drifts - the published 0.2.0 reported 0.1.0 (found 2026-09-26).
 * npm always ships package.json, and `../package.json` resolves from `src/` and
 * `dist/` alike.
 *
 * In its own module so `index.ts` and `cloud-commands.ts` can both have it
 * without a cycle: `index` imports the commands, so the commands cannot import
 * `index`. A second copy of the three lines would be a second thing to drift,
 * which is the bug this constant already exists to prevent.
 */
export const VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version
