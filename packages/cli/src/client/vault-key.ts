// The vault key, derived here from the passphrase and checked - once, for
// every caller: `team unlock`, `vault unlock`, and a personal map opened or
// sealed with the passphrase. Three copies of this had grown, and a KDF change
// or a new check fixed in one would have left the other two wrong (review).
//
// The server holds the salt, the KDF cost and a verifier - all it can hold.
// The passphrase never leaves this machine, and the key is never sent or
// written: it is non-extractable, used in memory and dropped.

import {
  checkVaultVerifier,
  deriveVaultKey,
  fromBase64,
  type CryptoKeyLike,
} from '@veilio-inc/engine'
import { getVault } from '../cloud.js'
import type { Credential } from '../credential.js'
import { refuse, refusalFromCloudError, type Outcome } from './wording.js'

export async function vaultKeyFor(
  credential: Credential,
  passphrase: (() => Promise<string>) | undefined
): Promise<Outcome<CryptoKeyLike>> {
  let vault
  try {
    vault = await getVault(credential)
  } catch (err) {
    return { ok: false, refusal: refusalFromCloudError(err, { project: credential.project }) }
  }
  // Said plainly rather than as a decryption failure: there is nothing to try
  // a passphrase against.
  if (!vault.initialized) return refuse('no_vault')
  const typed = passphrase ? await passphrase() : ''
  if (typed === '') return refuse('no_passphrase')
  const key = await deriveVaultKey(
    typed,
    fromBase64(vault.salt),
    vault.kdf ? { name: 'PBKDF2-SHA256', iterations: vault.kdf.iterations } : undefined
  )
  // Before anything is opened, sealed or written: a wrong passphrase is named
  // as one, rather than surfacing later as an authentication-tag failure that
  // reads like corruption - or as a key wrapped for good under the wrong one.
  if (!(await checkVaultVerifier(key, vault.verifier))) return refuse('wrong_passphrase')
  return { ok: true, value: key }
}
