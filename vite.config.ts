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
    // Playwright specs live in e2e/ and match vitest's default spec glob. Left
    // in, vitest would load them and fail on the @playwright/test import.
    // Setting `exclude` replaces vitest's defaults rather than adding to them,
    // so the standard entries are repeated here alongside e2e.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      'e2e/**',
    ],
  },
})
