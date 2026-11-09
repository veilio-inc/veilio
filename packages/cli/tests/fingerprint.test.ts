import { describe, it, expect } from 'vitest'
import { fingerprint, sameFingerprint } from '../src/client/fingerprint.js'

// Spec 080 item 7a: the CLI's fingerprint must be the one the web app shows
// (Cloud `frontend/src/lib/keyPinning.ts` `fingerprint()`, rendered by
// `OwnFingerprint`), or two people comparing them would never agree.
//
// These outputs were produced by running Cloud's own `fingerprint()` on the
// public keys of Cloud's `wrapKat.test.ts`, and checked against
// `base64 -d | shasum -a 256`. If this fails, the two clients disagree.
const VECTORS: [string, string][] = [
  ['moRtanz8qoyL2tl8EvK7oqQ01lTZ5M23UG9YDW4kGwM=', '046ee-6b73d-7baf9-15c9f'],
  ['odqs7vzZdTulNreUY414HgPCvD4oW1pO41Dodpef120=', '1ed35-3a46e-32b85-c3281'],
  ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', '66687-aadf8-62bd7-76c8f'],
]

describe('fingerprint - known answers shared with the web app', () => {
  it.each(VECTORS)('%s -> %s', async (publicKey, expected) => {
    expect(await fingerprint(publicKey)).toBe(expected)
  })
})

describe('comparing a typed fingerprint', () => {
  const fp = '046ee-6b73d-7baf9-15c9f'
  it.each([fp, '046EE-6B73D-7BAF9-15C9F', '046ee 6b73d 7baf9 15c9f', ' 046ee6b73d7baf915c9f '])(
    'accepts %j',
    (typed) => {
      expect(sameFingerprint(typed, fp)).toBe(true)
    }
  )

  it.each(['046ee-6b73d-7baf9-15c9e', '046ee-6b73d-7baf9', '', '046ee-6b73d-7baf9-15c9f0'])(
    'refuses %j',
    (typed) => {
      expect(sameFingerprint(typed, fp)).toBe(false)
    }
  )
})
