import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/**'],
      thresholds: { lines: 90, functions: 90, branches: 80 },
    },
  },
})
