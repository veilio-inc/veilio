// The commands that reach the network: login, logout, whoami.
//
// Deliberately NOT in commands.ts. That module is the local command path, and
// `offline.test.ts` walks its import graph and fails if it can reach `cloud.ts`
// — which is the structural half of the promise that `veilio scrub` on a laptop
// with no account touches nothing (FR-002). Putting these here is what keeps
// that walk meaningful instead of something to be deleted the moment it becomes
// inconvenient.

import {
  CloudError,
  createMap,
  getMap,
  getVault,
  listMaps,
  request,
  type CloudMap,
  type CloudMapList,
  type VaultInfo,
} from './cloud.js'
import {
  checkVaultVerifier,
  decryptMapFromVault,
  deriveVaultKey,
  encryptMapForVault,
  fromBase64,
  parseVaultEnvelope,
  type SymbolMap,
} from '@veilio-inc/engine'
import { loadMap, loadRemote, saveMap } from './store.js'
import { readCredential, removeCredential, writeCredential, type Credential } from './credential.js'
import { EXIT_ERROR, EXIT_OK, type Io } from './commands.js'
import { DEFAULT_INSTANCE } from './cloud.js'

/** The endpoint a sign-in is checked against. See `runLogin`. */
const ENTITLED_PROBE = '/api/maps'

interface LoginResponse {
  token: string
  user?: { email?: string }
}

/**
 * Sign in, and store the credential only if the account can actually use it.
 *
 * Two requests, and the second one is the interesting one.
 *
 * `POST /api/auth/login` answers "is this the right password". It does NOT
 * answer "does this plan include the terminal" — a free account signs in
 * perfectly well, because signing in is how you reach the billing page. So a
 * CLI that stopped after the first request would store a credential for an
 * account that gets refused by every command that follows, and would report
 * that refusal as though the sign-in had worked.
 *
 * The obvious shortcut is to read `user.plan` out of the login response and
 * decide locally. That is exactly what FR-009 forbids: entitlement is the
 * server's answer on each request, never the client's reading of a plan name.
 * A copy of the rule shipped to other people's laptops is a second definition of
 * it, and the one that goes stale first.
 *
 * So the second request asks the server a real question and lets it refuse. Only
 * then is anything written — validate, then persist (Constitution IV). A
 * credential written first and validated after leaves a file behind for an
 * attempt that failed, and everything looks signed in until the first command
 * that isn't.
 */
export async function runLogin(instance: string | null, io: Io): Promise<number> {
  const base = instance ?? DEFAULT_INSTANCE

  const account = (await requirePrompt(io, `Email for ${base}: `)).trim()
  if (account === '') {
    io.stderr('veilio: no email given\n')
    return EXIT_ERROR
  }
  const password = await requirePassword(io, 'Password: ')
  if (password === '') {
    io.stderr('veilio: no password given\n')
    return EXIT_ERROR
  }

  let session: LoginResponse
  try {
    session = await request<LoginResponse>('/api/auth/login', {
      instance: base,
      method: 'POST',
      body: { email: account, password },
    })
  } catch (err) {
    return reportLoginFailure(err, io)
  }

  if (typeof session.token !== 'string' || session.token === '') {
    // A 200 with no token is not a sign-in. Writing an empty credential here
    // would produce a "signed in" state that fails on every use.
    io.stderr(`veilio: ${base} accepted the sign-in but returned no session\n`)
    return EXIT_ERROR
  }

  const credential: Credential = {
    token: session.token,
    account: session.user?.email ?? account,
    instance: base,
  }

  try {
    await request(ENTITLED_PROBE, { credential })
  } catch (err) {
    return reportLoginFailure(err, io)
  }

  writeCredential(credential, io.home)
  io.stdout(`Signed in to ${base} as ${credential.account}\n`)
  return EXIT_OK
}

/**
 * Sign out: revoke server-side, THEN remove the file.
 *
 * The order is the control. Removing the file first makes `logout` always look
 * like it worked, while leaving a live session on the server that the user has
 * been told is gone — and nothing anywhere reports that. So a failed revocation
 * keeps the credential and says so, which is the loud failure rather than the
 * quiet one (Constitution V).
 */
export async function runLogout(io: Io): Promise<number> {
  const credential = readCredential(io.home)
  if (!credential) {
    io.stdout('Not signed in.\n')
    return EXIT_OK
  }

  try {
    await request('/api/auth/logout', { credential, method: 'POST', body: {} })
  } catch (err) {
    if (err instanceof CloudError && err.kind === 'unauthenticated') {
      // Already revoked, or expired. The server-side state is what logout
      // wanted, so finishing the job locally is correct rather than an error.
      try {
        removeCredential(io.home)
      } catch (removeErr) {
        io.stderr(
          `veilio: that session was already gone, but the credential file could not be removed ` +
            `(${removeErr instanceof Error ? removeErr.message : String(removeErr)}).\n`
        )
        return EXIT_ERROR
      }
      io.stdout('That session was already revoked or expired. Signed out locally.\n')
      return EXIT_OK
    }
    const detail = err instanceof Error ? err.message : String(err)
    io.stderr(
      `veilio: could not revoke the session (${detail}).\n` +
        'You are still signed in — the credential has been kept so you can try again. ' +
        'To end the session now, sign out from the web app.\n'
    )
    return EXIT_ERROR
  }

  try {
    removeCredential(io.home)
  } catch (err) {
    // The session IS revoked — that part worked. What failed is removing the
    // local file, and saying "signed out" while a dead token sits on disk is a
    // smaller lie than the reverse but still a lie.
    io.stderr(
      `veilio: the session was revoked, but the credential file could not be removed ` +
        `(${err instanceof Error ? err.message : String(err)}). Delete it by hand.\n`
    )
    return EXIT_ERROR
  }
  io.stdout(`Signed out of ${credential.instance}.\n`)
  return EXIT_OK
}

/**
 * Who is signed in, answered from disk.
 *
 * Makes no request, on purpose. Its job is "am I signed in", not "is Cloud up" —
 * an answer that needs the network is useless at exactly the moment somebody is
 * trying to work out why the network isn't working.
 */
export function runWhoami(io: Io): number {
  const credential = readCredential(io.home)
  if (!credential) {
    io.stdout('Not signed in. Run `veilio login` to connect a Veilio Cloud account.\n')
    return EXIT_OK
  }
  io.stdout(`${credential.account} on ${credential.instance}\n`)
  return EXIT_OK
}

/**
 * Say which kind of refusal this was.
 *
 * FR-007: "wrong password" and "not on your plan" have different remedies and
 * must never print the same thing. Sending someone to re-type a password that
 * was correct is worse than saying nothing.
 */
function reportLoginFailure(err: unknown, io: Io): number {
  if (err instanceof CloudError) {
    switch (err.kind) {
      case 'unauthenticated':
        io.stderr('veilio: that email and password were not accepted.\n')
        return EXIT_ERROR
      case 'unentitled':
        io.stderr(
          `veilio: signed in, but this account’s plan does not include terminal access — ${err.message}\n` +
            'Your password is fine. Change the plan in the web app to use the CLI with Cloud.\n'
        )
        return EXIT_ERROR
      case 'suspended':
        // A different refusal with a different remedy again, and the one that
        // must not read as a billing problem: this account is under review, and
        // buying a bigger plan changes nothing.
        io.stderr(
          `veilio: ${err.message}\n` +
            'Export and deletion still work in the web app. Nothing else will until the review ends.\n'
        )
        return EXIT_ERROR
      case 'forbidden':
        io.stderr(`veilio: ${err.message}\n`)
        return EXIT_ERROR
      case 'unreachable':
        io.stderr(`veilio: ${err.message}\n`)
        return EXIT_ERROR
      case 'server':
        io.stderr(`veilio: the instance reported an error — ${err.message}\n`)
        return EXIT_ERROR
    }
  }
  io.stderr(`veilio: ${err instanceof Error ? err.message : String(err)}\n`)
  return EXIT_ERROR
}

async function requirePrompt(io: Io, label: string): Promise<string> {
  if (!io.prompt) throw new Error('this build cannot read input interactively')
  return io.prompt(label)
}

async function requirePassword(io: Io, label: string): Promise<string> {
  if (!io.password) throw new Error('this build cannot read a password interactively')
  return io.password(label)
}

// ─── maps: list, pull, push ──────────────────────────────────────────────────

/**
 * List what the account holds.
 *
 * Prints the id, because `pull` takes one. A name would be friendlier and is
 * wrong: names are not unique, and picking "the first one that matches" is how
 * somebody pulls a different map over the one they were using.
 */
export async function runMapsList(io: Io): Promise<number> {
  const credential = readCredential(io.home)
  if (!credential) return notSignedIn(io)

  let list: CloudMapList
  try {
    list = await listMaps(credential)
  } catch (err) {
    return reportCloudFailure(err, io)
  }

  const all = [...list.personalMaps, ...list.teamMaps]
  if (all.length === 0) {
    io.stdout('No maps in Cloud yet. `veilio maps push <name>` uploads the local one.\n')
    return EXIT_OK
  }
  for (const map of all) {
    const count = map.identifier_count === null ? '?' : String(map.identifier_count)
    io.stdout(`${map.id}  ${map.scope.padEnd(8)} ${count.padStart(5)} symbols  ${map.name}\n`)
  }
  return EXIT_OK
}

/**
 * Pull a map into the local store: decrypt FIRST, write second.
 *
 * The ordering is the control (Constitution IV). Writing before decrypting means
 * a wrong passphrase leaves a half-built store behind — and the store is the one
 * thing that can restore text already anonymized, so a partial write there is
 * not an inconvenience, it is unrecoverable text.
 *
 * A personal map is opened HERE. The server holds the salt and a verifier and
 * nothing else; the passphrase never leaves this machine, and there is no code
 * path in this package that could send it.
 */
export async function runMapsPull(
  id: string | null,
  mapPath: string,
  io: Io,
  options: { force?: boolean } = {}
): Promise<number> {
  const credential = readCredential(io.home)
  if (!credential) return notSignedIn(io)
  if (!id) {
    io.stderr('veilio: which map? Run `veilio maps list` for the ids.\n')
    return EXIT_ERROR
  }

  let remote: CloudMap
  try {
    remote = await getMap(credential, id)
  } catch (err) {
    return reportCloudFailure(err, io)
  }

  // A team map arrives already open — the server can read those, and says so in
  // the privacy policy. Only a client envelope is ours to decrypt.
  let map: SymbolMap
  if (typeof remote.map_data !== 'string') {
    map = remote.map_data
  } else {
    let vault: VaultInfo
    try {
      vault = await getVault(credential)
    } catch (err) {
      return reportCloudFailure(err, io)
    }
    if (!vault.initialized) {
      // Stated plainly rather than surfaced as a decryption failure. There is
      // nothing to try a passphrase against, and inviting one would be asking
      // somebody to guess at a lock that does not exist.
      io.stderr(
        'veilio: this account has no vault, so there is no key for that map. ' +
          'Create one in the web app first — it is the passphrase your maps are encrypted under.\n'
      )
      return EXIT_ERROR
    }

    const passphrase = io.password ? await io.password('Vault passphrase: ') : ''
    if (passphrase === '') {
      io.stderr('veilio: no passphrase given\n')
      return EXIT_ERROR
    }

    const key = await deriveVaultKey(
      passphrase,
      fromBase64(vault.salt),
      vault.kdf ? { name: 'PBKDF2-SHA256', iterations: vault.kdf.iterations } : undefined
    )
    // The verifier answers "is this the right passphrase" before anything is
    // decrypted, so a wrong one is named as a wrong passphrase rather than
    // surfacing as an authentication-tag failure that reads like corruption.
    if (!(await checkVaultVerifier(key, vault.verifier))) {
      io.stderr('veilio: that vault passphrase is not right. Nothing was written.\n')
      return EXIT_ERROR
    }
    try {
      map = await decryptMapFromVault(key, parseVaultEnvelope(remote.map_data))
    } catch (err) {
      io.stderr(
        `veilio: that map could not be opened — ${err instanceof Error ? err.message : String(err)}. ` +
          'Nothing was written.\n'
      )
      return EXIT_ERROR
    }
  }

  // Only now is anything touched on disk.
  const existing = loadRemote(mapPath)
  const local = loadMap(mapPath)
  const hasLocal = Object.keys(local).length > 0
  const diverged =
    hasLocal &&
    existing !== undefined &&
    existing.id === remote.id &&
    existing.updatedAt !== remote.updated_at &&
    JSON.stringify(local) !== JSON.stringify(map)

  if (diverged && options.force !== true) {
    // Reported, not resolved. Overwriting either side silently loses entries
    // that some text out there still depends on.
    io.stderr(
      `veilio: this map changed in Cloud (${existing.updatedAt} → ${remote.updated_at}) and ` +
        'locally since it was pulled. Neither copy has been touched.\n' +
        `Pass --force to overwrite the local copy, or export it first with \`veilio map --json\`.\n`
    )
    return EXIT_ERROR
  }

  const now = new Date().toISOString()
  saveMap(mapPath, map, {
    force: true,
    remote: { id: remote.id, updatedAt: remote.updated_at, pulledAt: now },
  })
  io.stdout(`Pulled "${remote.name}" (${Object.keys(map).length} symbols) into ${mapPath}\n`)
  return EXIT_OK
}

/** Upload the local map. Same endpoint, same quotas, same validation. */
export async function runMapsPush(name: string | null, mapPath: string, io: Io): Promise<number> {
  const credential = readCredential(io.home)
  if (!credential) return notSignedIn(io)

  const map = loadMap(mapPath)
  if (Object.keys(map).length === 0) {
    io.stderr(`veilio: there is no local map at ${mapPath} to push.\n`)
    return EXIT_ERROR
  }

  let vault: VaultInfo
  try {
    vault = await getVault(credential)
  } catch (err) {
    return reportCloudFailure(err, io)
  }
  if (!vault.initialized) {
    io.stderr(
      'veilio: this account has no vault, so there is no key to encrypt with. ' +
        'Create one in the web app first.\n'
    )
    return EXIT_ERROR
  }

  const passphrase = io.password ? await io.password('Vault passphrase: ') : ''
  if (passphrase === '') {
    io.stderr('veilio: no passphrase given\n')
    return EXIT_ERROR
  }
  const key = await deriveVaultKey(
    passphrase,
    fromBase64(vault.salt),
    vault.kdf ? { name: 'PBKDF2-SHA256', iterations: vault.kdf.iterations } : undefined
  )
  if (!(await checkVaultVerifier(key, vault.verifier))) {
    // Caught before anything is uploaded. Pushing under the wrong key would
    // store a map the account can never open again.
    io.stderr('veilio: that vault passphrase is not right. Nothing was uploaded.\n')
    return EXIT_ERROR
  }

  const envelope = await encryptMapForVault(key, map)
  let created: { id: string }
  try {
    created = await createMap(credential, {
      name: name ?? 'from the terminal',
      map_data: JSON.stringify(envelope),
      identifier_count: Object.keys(map).length,
      scope: 'personal',
    })
  } catch (err) {
    return reportCloudFailure(err, io)
  }

  saveMap(mapPath, map, {
    force: true,
    remote: {
      id: created.id,
      updatedAt: new Date().toISOString(),
      pushedAt: new Date().toISOString(),
    },
  })
  io.stdout(`Pushed ${Object.keys(map).length} symbols to Cloud as ${created.id}\n`)
  return EXIT_OK
}

function notSignedIn(io: Io): number {
  io.stderr('veilio: not signed in. Run `veilio login` first.\n')
  return EXIT_ERROR
}

/** Same distinctions as a failed sign-in, minus the ones only login can hit. */
function reportCloudFailure(err: unknown, io: Io): number {
  return reportLoginFailure(err, io)
}
