// A public key's fingerprint, as two people read it out to each other when one
// confirms a key the other granted (spec 080 item 7a).
//
// Byte-identical to Cloud `frontend/src/lib/keyPinning.ts` `fingerprint()`,
// which the web app shows a member as "Your key fingerprint": the first 20 hex
// characters of SHA-256 over the raw key, in four groups of five joined by `-`.
// The shared known-answer vectors are in tests/fingerprint.test.ts.

import { fromBase64 } from '@veilio-inc/engine'

export async function fingerprint(publicKeyBase64: string): Promise<string> {
  const hex = await keyDigest(publicKeyBase64)
  return (hex.slice(0, 20).match(/.{5}/g) ?? []).join('-')
}

/** The whole SHA-256 (lowercase hex) over the raw key: what a grant sends as
 *  `recipientKeyFingerprint`, as Cloud `frontend/src/lib/api.ts` does. */
export async function keyDigest(publicKeyBase64: string): Promise<string> {
  const raw = fromBase64(publicKeyBase64)
  const digest = await crypto.subtle.digest('SHA-256', raw as unknown as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A typed fingerprint against a computed one: spaces, dashes and case ignored. */
export function sameFingerprint(typed: string, actual: string): boolean {
  const bare = (s: string) => s.replace(/[\s-]/g, '').toLowerCase()
  return bare(typed) === bare(actual)
}
