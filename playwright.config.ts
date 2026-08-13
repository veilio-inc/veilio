import { defineConfig, devices } from '@playwright/test'

// End-to-end tests exist for one reason the unit suite cannot cover: jsdom has
// no layout engine, so a real CodeMirror text selection — the entry point to
// manual masking — cannot be made there. Everything here needs a real browser.
// Point the suite at an already-running instance — chiefly the Docker image —
// with VEILIO_E2E_URL. Unset, it starts its own preview server. Being able to
// run the same assertions against the artifact users actually pull is the point:
// a bundle that passes in `vite preview` and fails behind the container's static
// server would otherwise ship unnoticed.
const externalURL = process.env.VEILIO_E2E_URL
const baseURL = externalURL ?? 'http://localhost:4173'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Preview, not dev: this should exercise the built bundle, which is also what
  // the Docker image ships.
  webServer: externalURL
    ? undefined
    : {
        command: 'npm run preview -- --port 4173 --strictPort',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
})
