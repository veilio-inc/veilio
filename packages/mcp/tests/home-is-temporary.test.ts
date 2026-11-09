import { describe, it, expect } from 'vitest'
import { homedir, tmpdir, userInfo } from 'node:os'
import { realpathSync } from 'node:fs'

// Spec 085 part 3: no test may touch the developer's real ~/.veilio (maps,
// keys, the written-maps record). vitest.setup.ts gives every test file a
// temporary HOME; this fails when it does not.
describe('the test HOME', () => {
  it('is a temporary folder, never the real home', () => {
    expect(homedir()).not.toBe(userInfo().homedir)
    expect(realpathSync(homedir()).startsWith(realpathSync(tmpdir()))).toBe(true)
  })
})
