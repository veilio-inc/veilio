// `defineConfig` comes from vitest/config, not vite: the `test` block below is
// vitest's, and vite's own overload does not know about it. Under vitest 2 the
// looser typing let it pass; under 4 it is a type error, which is the honest
// result — this file has always been a vitest config as well as a vite one.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  test: {
    // Node 22.4+ (we run Node 26) ships an experimental Web Storage global whose
    // dead accessor SHADOWS the localStorage jsdom would otherwise provide, so
    // `window.localStorage` reads as undefined under `@vitest-environment
    // jsdom`. This restores a working in-memory Storage. Safe under the node
    // environment too: it installs only when the global is missing or broken.
    setupFiles: ['./src/test-setup.ts'],
    // Playwright specs live in e2e/ and match vitest's default spec glob. Left
    // in, vitest would load them and fail on the @playwright/test import.
    // Setting `exclude` replaces vitest's defaults rather than adding to them,
    // so the standard entries are repeated here alongside e2e.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      'e2e/**',
      // Scratch captures for social posts. Gitignored, Playwright-flavoured,
      // and with siblings that may not exist — collecting them makes a clean
      // local run look broken for a directory that is not part of the project.
      'social/**',
      // Each workspace under packages/ owns a vitest config, and `npm run
      // test:packages` runs them. Without this the root run collects them too,
      // under the app's config — which is not the config they are written
      // against, and quietly doubles the CI time. It also breaks outright:
      // packages/mcp imports `@veilio-inc/cli/store`, which resolves through the
      // CLI's exports map into packages/cli/dist, a directory that exists only
      // after a build.
      'packages/**',
    ],
  },
})
