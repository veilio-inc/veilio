// Flat config, replacing .eslintrc.json.
//
// ESLint 9 dropped the .eslintrc format and 10 removed the fallback entirely:
// with an .eslintrc.json and no eslint.config.*, ESLint 10 does not lint
// anything and fails with "couldn't find an eslint.config.* file". It also
// removed the `--ext` flag, so the lint scripts pass file globs directly.
//
// This is a translation, not a re-think. Same three extends, same three rule
// overrides, same environments as the .eslintrc.json it replaces.

import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default [
  // `eslint:recommended`, a named export in flat config rather than a string.
  // Scoped to the files we actually lint: a bare config object applies to
  // everything, including tooling .js that was never in scope under
  // `--ext .ts,.tsx`.
  {
    files: ['**/*.ts', '**/*.tsx'],
    ...js.configs.recommended,
  },

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      // Was `env: { browser: true, es2022: true }`. Flat config has no `env`;
      // the globals those switched on are listed directly. `node` is added for
      // the halves of this repo that are not the browser app - e2e/ drives
      // Playwright and packages/*/src are a CLI and an MCP server - which the
      // old config got away with only because no-undef is off for TypeScript.
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // `plugin:@typescript-eslint/recommended` is two layers, and extending it
      // by name used to pull in both. The first switches off the core rules the
      // compiler already enforces - without it `no-undef` runs against
      // TypeScript and reports errors for globals that plainly exist.
      ...tsPlugin.configs['eslint-recommended'].overrides[0].rules,
      // Spread rather than extended, because the plugin's flat presets carry
      // their own `files` scoping and would otherwise widen what gets linted.
      ...tsPlugin.configs.recommended.rules,

      // The three overrides from .eslintrc.json, unchanged.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // `prettier` last, so it can switch off the stylistic rules above. Same
  // position it held in the old `extends` array.
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: prettier.rules,
  },
]
