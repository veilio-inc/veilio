// The test kit's own types for `$` and `on`, as a test body receives them,
// for helpers that take them. Claude Code's 'claude-code/testing' declares
// them; a type-only import is erased when the tests run.
import type { test } from 'claude-code/testing'

type Body = Extract<Parameters<typeof test>[number], (...args: never[]) => unknown>
export type TestHost = Parameters<Body>[0]
export type TestOn = Parameters<Body>[1]
