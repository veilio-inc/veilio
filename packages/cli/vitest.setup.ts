// Every test file runs with a temporary HOME (spec 085 part 3): no test may
// read or write the developer's real ~/.veilio - credentials, keys, cached
// rules, or the record of written maps. `os.homedir()` reads HOME
// (USERPROFILE on Windows) on each call; tests that need a home of their own
// still set one.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'veilio-test-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
