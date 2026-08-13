import { defineConfig } from 'vite'
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
