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
  deleteMap,
  getMap,
  reservePlaceholders,
  getVault,
  getUserKeys,
  getTeamKeyWraps,
  listMaps,
  listRules,
  request,
  type CloudMap,
  type CloudMapList,
  type VaultInfo,
} from './cloud.js'
import {
  checkVaultVerifier,
  decryptMapFromVault,
  deriveVaultKey,
  unwrapPrivateKey,
  unwrapTeamKey,
  exportTeamKey,
  encryptMapForVault,
  fromBase64,
  parseVaultEnvelope,
  importTeamKey,
  encryptTeamMap,
  decryptTeamMapWithAny,
  type CryptoKeyLike,
  type SymbolMap,
  type TeamMapEnvelope,
  type TeamLayer,
} from '@veilio-inc/engine'
import { loadMap, loadRemote, saveMap } from './store.js'
import { resolveTeamNamespace, teamLayerNote } from './team-namespace.js'
import {
  readTeamUnlock,
  removeTeamUnlock,
  writeTeamUnlock,
  teamUnlockPath,
  expiryFrom,
  type StoredTeamKey,
} from './team-unlock.js'
import { readCredential, removeCredential, writeCredential, type Credential } from './credential.js'
import { mergeRules, removeRules, rulesPath, writeRules } from './rules.js'
import { EXIT_ERROR, EXIT_OK, type Io, type TeamNamespaceSource } from './commands.js'
import { DEFAULT_INSTANCE } from './cloud.js'

/** The endpoint a sign-in is checked against. See `runLogin`. */
const ENTITLED_PROBE = '/api/maps'

interface LoginResponse {
  token: string
  user?: { email?: string }
  /** The account has a second factor: `token` is then a five-minute CHALLENGE,
   *  good only for POST /api/auth/2fa/verify - never a session. */
  secondFactorRequired?: boolean
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

  // A second factor. The token that came back is a challenge, not a session:
  // storing it made every later command fail, and the failure read as a wrong
  // password (found on staging, 2026-09-26). Ask for the code and complete the
  // sign-in the way the web app does.
  if (session.secondFactorRequired === true) {
    const code = (await requirePrompt(io, 'Authentication code (or a recovery code): ')).trim()
    if (code === '') {
      io.stderr('veilio: no authentication code given\n')
      return EXIT_ERROR
    }
    try {
      session = await request<LoginResponse>('/api/auth/2fa/verify', {
        credential: { token: session.token, account, instance: base },
        method: 'POST',
        body: { code },
      })
    } catch (err) {
      if (err instanceof CloudError && err.kind === 'unauthenticated') {
        io.stderr(
          'veilio: that authentication code was not accepted, or it expired. ' +
            'Run `veilio login` again with a fresh code.\n'
        )
        return EXIT_ERROR
      }
      return reportLoginFailure(err, io)
    }
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
      //
      // "Locally" has to include the team keys. They outlive the session that
      // fetched them — a revoked token stops working, an unlocked team key goes
      // on opening the team's maps — so leaving them here would be the one
      // branch where signing out quietly kept the more dangerous half.
      try {
        removeTeamUnlock(io.home)
        removeRules(io.home)
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

  // Before the credential, because this is key material rather than a token
  // the server has already revoked. Signing out while the team's keys stay
  // readable on disk is exactly the gap between what a person believes they
  // gave up and what is still there.
  try {
    removeTeamUnlock(io.home)
  } catch (err) {
    io.stderr(
      `veilio: the session was revoked, but the unlocked team keys could not be removed ` +
        `(${err instanceof Error ? err.message : String(err)}). Delete ${teamUnlockPath(io.home)} by hand.\n`
    )
    return EXIT_ERROR
  }
  // The rules are the account's too, and a whitelist among them keeps names
  // readable: they go with the session rather than outliving it.
  try {
    removeRules(io.home)
  } catch (err) {
    io.stderr(
      `veilio: the session was revoked, but the cached custom rules could not be removed ` +
        `(${err instanceof Error ? err.message : String(err)}). Delete ${rulesPath(io.home)} by hand.\n`
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
 * Open a team map with the team keys `veilio team unlock` stored.
 *
 * The same keys the MCP server reads, for the same reason: this machine may
 * have nobody present to type a vault passphrase, and the team key - not the
 * vault key - is what a team map is sealed under. Reports and returns null
 * when it cannot, so the caller writes nothing.
 */
async function openTeamEnvelope(
  credential: Credential,
  mapData: string,
  io: Io
): Promise<SymbolMap | null> {
  const unlock = readTeamUnlock(
    { instance: credential.instance, account: credential.account },
    io.home
  )
  if (!unlock || unlock.keys.length === 0) {
    io.stderr(
      'veilio: that is a team map, and no team key is unlocked on this machine. ' +
        'Run `veilio team unlock` first. Nothing was written.\n'
    )
    return null
  }
  const keys: { version: number; key: CryptoKeyLike }[] = []
  for (const stored of unlock.keys) {
    try {
      keys.push({ version: stored.version, key: await importTeamKey(stored.key) })
    } catch {
      // A damaged entry; the others may still open the map.
      continue
    }
  }
  try {
    return await decryptTeamMapWithAny(keys, JSON.parse(mapData) as TeamMapEnvelope)
  } catch (err) {
    io.stderr(
      `veilio: that team map could not be opened with the unlocked team keys — ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'If the team key was rotated since, run `veilio team unlock` again. Nothing was written.\n'
    )
    return null
  }
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

  // Every map is an envelope the server cannot open: a personal map under the
  // vault key, a team map under the team key. Which one is written on the
  // envelope itself.
  if (typeof remote.map_data !== 'string') {
    io.stderr('veilio: that map is not an encrypted envelope, so it was not written.\n')
    return EXIT_ERROR
  }
  let envelope: { alg?: unknown }
  try {
    envelope = JSON.parse(remote.map_data) as { alg?: unknown }
  } catch {
    io.stderr('veilio: that map is not an encrypted envelope, so it was not written.\n')
    return EXIT_ERROR
  }

  let map: SymbolMap
  if (envelope.alg === 'AES-256-GCM-TEAM') {
    const opened = await openTeamEnvelope(credential, remote.map_data, io)
    if (!opened) return EXIT_ERROR
    map = opened
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
      `veilio: this map changed in Cloud (${existing!.updatedAt} → ${remote.updated_at}) and ` +
        'locally since it was pulled. Neither copy has been touched.\n' +
        `Pass --force to overwrite the local copy, or export it first with \`veilio map --json\`.\n`
    )
    return EXIT_ERROR
  }

  // Whether or not the Cloud copy changed: a local entry the pulled map lacks,
  // or gives another name, is a placeholder some masked text still depends on
  // (staging walk, 2026-10-01 - a scrub after a pull was lost on the next pull).
  const dropped = Object.keys(local).filter((p) => map[p] !== local[p])
  if (dropped.length > 0 && options.force !== true) {
    const shown =
      dropped.slice(0, 5).join(', ') + (dropped.length > 5 ? ` and ${dropped.length - 5} more` : '')
    io.stderr(
      `veilio: pulling "${remote.name}" would drop ${dropped.length} placeholder(s) this project's map has: ${shown}. ` +
        'Nothing was written.\n' +
        `Push this map first (\`veilio maps push\`), pass --force to replace it, or export it with \`veilio map --json\`.\n`
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

/**
 * Placeholders the local map and the team's namespace use for DIFFERENT names.
 *
 * Publishing one of these creates a DISPUTED placeholder, and
 * `restoreLayers.disputedIn` then refuses to restore it for every member of
 * the team until somebody deletes a map. One person's push, a cost paid by
 * everyone, and nothing errors at the time - so it is checked before anything
 * is sealed rather than reported afterwards.
 *
 * An identifier the team holds under a DIFFERENT placeholder is an alias, not
 * a conflict: both still restore (spec 017), so those pass.
 *
 * A map anonymized with `reservedAnonymizeOverTeam` cannot reach this, because
 * its numbers came out of the team's own allocation. This is for maps that
 * predate it - numbered locally, possibly before this account joined a team.
 */
export function conflictsWithTeam(
  local: Record<string, string>,
  teamNamespace: Record<string, string>
): { placeholder: string; mine: string; theirs: string }[] {
  const out: { placeholder: string; mine: string; theirs: string }[] = []
  for (const [placeholder, mine] of Object.entries(local)) {
    const theirs = teamNamespace[placeholder]
    if (theirs !== undefined && theirs !== mine) out.push({ placeholder, mine, theirs })
  }
  return out
}

/** Upload the local map. Same endpoint, same quotas, same validation. */
export async function runMapsPush(
  name: string | null,
  mapPath: string,
  io: Io,
  toTeam = false
): Promise<number> {
  const credential = readCredential(io.home)
  if (!credential) return notSignedIn(io)

  const map = loadMap(mapPath)
  if (Object.keys(map).length === 0) {
    io.stderr(`veilio: there is no local map at ${mapPath} to push.\n`)
    return EXIT_ERROR
  }

  if (toTeam) return pushToTeam(name, mapPath, map, credential, io)

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

// ─── rules: pull ──────────────────────────────────────────────────────────────

/**
 * Fetch the account's custom rules so `veilio scrub` can apply them offline.
 *
 * Merged here, in the web app's order, so every later scrub applies exactly
 * what the browser would. A plan without custom rules REMOVES any cache left
 * from before: rules the account can no longer use must not go on shaping
 * its output. Any other failure keeps the cache and says so.
 */
export async function runRulesPull(io: Io): Promise<number> {
  const credential = readCredential(io.home)
  if (!credential) return notSignedIn(io)

  let fetched: Awaited<ReturnType<typeof listRules>>
  try {
    fetched = await listRules(credential)
  } catch (err) {
    if (err instanceof CloudError && err.kind === 'unentitled') {
      const removed = removeRules(io.home)
      io.stderr(
        `veilio: this account's plan does not include custom rules${removed ? ' - the cached rules were removed' : ''}.\n`
      )
      return EXIT_ERROR
    }
    return reportCloudFailure(err, io)
  }

  const personal = fetched.rules ?? []
  const team = fetched.teamRules ?? []
  const rules = mergeRules(personal, team)
  writeRules(
    {
      instance: credential.instance,
      account: credential.account,
      pulledAt: new Date().toISOString(),
      rules,
    },
    io.home
  )
  const skipped = personal.length + team.length - rules.length
  io.stdout(
    `Pulled ${rules.length} custom rule${rules.length === 1 ? '' : 's'} ` +
      `(${personal.length} personal, ${team.length} team${skipped > 0 ? `, ${skipped} disabled and skipped` : ''}). ` +
      '`veilio scrub` applies them.\n'
  )
  return EXIT_OK
}

// ─── team: unlock, lock ──────────────────────────────────────────────────────

/**
 * Unlock this team's keys for processes that cannot ask for a passphrase.
 *
 * The MCP server starts inside a coding agent with no terminal attached, so the
 * keys it needs have to be put on disk by a run like this one, where a person
 * is present to type the passphrase. See `team-unlock.ts` for what is stored
 * and why it is the team key rather than the vault key.
 */
export async function runTeamUnlock(io: Io, days?: number): Promise<number> {
  const credential = readCredential(io.home)
  if (!credential) {
    io.stderr('veilio: not signed in. Run `veilio login` first.\n')
    return EXIT_ERROR
  }

  try {
    const list = await listMaps(credential)
    const teamId = list.team?.id
    if (!teamId) {
      io.stderr(
        'veilio: this account is not in a team, so there are no team keys to unlock. ' +
          'Shared placeholders are a Team-plan feature.\n'
      )
      return EXIT_ERROR
    }

    const mine = await getUserKeys(credential)
    if (!mine.initialized) {
      io.stderr(
        'veilio: this account has no keypair yet. Open the web app once — that is where a ' +
          'keypair is created and where a teammate grants you the team key.\n'
      )
      return EXIT_ERROR
    }

    const { wraps } = await getTeamKeyWraps(credential, teamId)
    if (wraps.length === 0) {
      io.stderr(
        'veilio: no teammate has granted you the team key yet. Ask someone already in the ' +
          'team to open the web app, which is what performs the grant.\n'
      )
      return EXIT_ERROR
    }

    const vault = await getVault(credential)
    if (!vault.initialized) {
      io.stderr(
        'veilio: this account has no vault, so there is no key to unwrap anything with. ' +
          'Create one in the web app first.\n'
      )
      return EXIT_ERROR
    }

    const passphrase = io.password ? await io.password('Vault passphrase: ') : ''
    if (passphrase === '') {
      io.stderr('veilio: no passphrase given\n')
      return EXIT_ERROR
    }

    const vaultKey = await deriveVaultKey(
      passphrase,
      fromBase64(vault.salt),
      vault.kdf ? { name: 'PBKDF2-SHA256', iterations: vault.kdf.iterations } : undefined
    )
    // Named as a wrong passphrase here rather than surfacing later as an
    // authentication-tag failure that reads like corruption.
    if (!(await checkVaultVerifier(vaultKey, vault.verifier))) {
      io.stderr('veilio: that vault passphrase is not right. Nothing was written.\n')
      return EXIT_ERROR
    }

    const privateKey = await unwrapPrivateKey(vaultKey, mine.privateKeyEncrypted)

    const keys: StoredTeamKey[] = []
    for (const wrap of wraps) {
      try {
        const teamKey = await unwrapTeamKey(wrap.wrapped_key, privateKey, {
          teamId,
          version: wrap.version,
          myPublicKey: mine.publicKey,
        })
        keys.push({ version: wrap.version, key: await exportTeamKey(teamKey) })
      } catch {
        // A wrap this account cannot open — from a granter whose key has since
        // changed, most likely. Skipped rather than fatal: another version may
        // still open most of the team's maps, and none opening is reported below.
        continue
      }
    }

    if (keys.length === 0) {
      io.stderr(
        'veilio: none of the team key wraps held for this account could be opened. ' +
          'Ask a teammate to grant access again from the web app.\n'
      )
      return EXIT_ERROR
    }

    const now = new Date()
    const expiresAt = expiryFrom(now, days)
    writeTeamUnlock(
      {
        v: 1,
        instance: credential.instance,
        account: credential.account,
        teamId,
        expiresAt,
        keys,
      },
      io.home
    )

    const versions = keys.map((k) => `v${k.version}`).join(', ')
    io.stdout(
      `Unlocked ${keys.length === 1 ? 'the team key' : 'team keys'} (${versions}) until ` +
        `${expiresAt}.\n` +
        `Stored in ${teamUnlockPath(io.home)}, readable only by you. ` +
        `Run \`veilio team lock\` to remove them.\n`
    )
    return EXIT_OK
  } catch (err) {
    return reportCloudFailure(err, io)
  }
}

/** Remove the unlocked team keys. */
export function runTeamLock(io: Io): number {
  try {
    if (!removeTeamUnlock(io.home)) {
      io.stdout('No team keys were unlocked.\n')
      return EXIT_OK
    }
  } catch (err) {
    io.stderr(
      `veilio: the unlocked team keys could not be removed ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `Delete ${teamUnlockPath(io.home)} by hand.\n`
    )
    return EXIT_ERROR
  }
  io.stdout('Team keys locked.\n')
  return EXIT_OK
}

// ─── restore: the team layer ────────────────────────────────────────────────

/**
 * The team's maps for `veilio restore` (spec 028), handed to the local command
 * as a callback so that command stays unlinked from the network. Signed out:
 * no request, no layer - a local restore, as before.
 */
export async function teamLayerFor(
  home: string | undefined,
  missing: readonly string[]
): Promise<{ team: TeamLayer | null; note: string | null }> {
  // Signed out, the resolver answers 'local' without a request. At most 5 s: a
  // hung instance must not stall a `... | veilio restore > file` pipeline.
  const found = await resolveTeamNamespace(home, { deadlineMs: RESTORE_CLOUD_WAIT_MS })
  if (found.status === 'team' && found.conflictDetection)
    return { team: found.analysis, note: null }
  return { team: null, note: teamLayerNote(found, missing) }
}

const RESTORE_CLOUD_WAIT_MS = 5000

/** What `veilio scrub` numbers from (spec 030): the team's namespace, or this
 *  project's map with the reason. Signed out or in no team: no request, no note. */
export async function teamNamespaceForScrub(
  home: string | undefined
): Promise<Awaited<ReturnType<TeamNamespaceSource>>> {
  const found = await resolveTeamNamespace(home, { deadlineMs: RESTORE_CLOUD_WAIT_MS })
  if (found.status === 'team') {
    const credential = readCredential(home)
    const teamId = found.teamId
    // No teamId means an older self-hosted instance that merged the namespace
    // server-side. It predates the reservation endpoint too, so there is
    // nothing to reserve against and a local floor is the only option - said
    // out loud rather than passed off as safe.
    if (!credential || !teamId) {
      return {
        team: found.analysis,
        note:
          teamId === null
            ? "this Cloud instance is too old to reserve placeholder numbers, so this was numbered from this project's map only and may clash with the team's placeholders."
            : null,
        reserve: null,
      }
    }
    return {
      team: found.analysis,
      note: null,
      reserve: async (requests) => (await reservePlaceholders(credential, teamId, requests)).ranges,
    }
  }
  if (found.status === 'locked')
    return {
      team: null,
      note: "the team key is locked on this machine, so this was numbered from this project's map only and may clash with the team's placeholders. Run `veilio team unlock`, then scrub again.",
    }
  if (found.status === 'unavailable')
    return {
      team: null,
      note: `could not read the team's maps (${found.reason}), so this was numbered from this project's map only and may clash with the team's placeholders.`,
    }
  return { team: null, note: null }
}

/**
 * Publish the local map as the TEAM's, from the terminal (spec 011 US1).
 *
 * Seals what is on disk AS IT IS NUMBERED. It does not renumber: by the time
 * anybody runs this, the local map's placeholders are already present in the
 * files they masked, and renumbering here would publish a map that disagrees
 * with every one of them - while `saveMap(force)` rewrote the local map too,
 * breaking local restore as well. Numbers come out of the team's allocation at
 * ANONYMIZE time (`reservedAnonymizeOverTeam`), which is where the text and
 * the numbers can still change together.
 *
 * So the ordering here is: establish that publishing is safe, THEN seal, THEN
 * upload. Every refusal happens before the first byte leaves (FR-007).
 */
async function pushToTeam(
  name: string | null,
  mapPath: string,
  map: Record<string, string>,
  credential: Credential,
  io: Io
): Promise<number> {
  // 1. The key. Read from the unlock file, never derived here: publishing
  //    needs the TEAM key, and nobody's passphrase can produce it.
  const unlock = readTeamUnlock(
    { instance: credential.instance, account: credential.account },
    io.home
  )
  if (!unlock || unlock.keys.length === 0) {
    io.stderr(
      'veilio: no team key is unlocked on this machine, so this map cannot be sealed for ' +
        'the team. Run `veilio team unlock` first. Nothing was uploaded.\n'
    )
    return EXIT_ERROR
  }

  // Newest first: a team mid-rotation holds two, and new content belongs under
  // the newer one. The version is declared on upload so the server can refuse
  // a write under a key a departed member knew (spec 014).
  const newest = [...unlock.keys].sort((a, b) => b.version - a.version)[0]!
  let teamKey
  try {
    teamKey = await importTeamKey(newest.key)
  } catch (err) {
    io.stderr(
      `veilio: the unlocked team key could not be read (${err instanceof Error ? err.message : String(err)}). ` +
        'Run `veilio team unlock` again. Nothing was uploaded.\n'
    )
    return EXIT_ERROR
  }

  // 2. The team's namespace, for the conflict check and for the report. A
  //    failure here is NOT fallback-to-local: publishing blind is what the
  //    check exists to prevent.
  const found = await resolveTeamNamespace(io.home)
  if (found.status === 'local') {
    io.stderr(
      'veilio: this account is not in a team, so there is no shared map to publish to. ' +
        'Nothing was uploaded.\n'
    )
    return EXIT_ERROR
  }
  if (found.status === 'locked') {
    io.stderr(
      'veilio: the team key on this machine does not match this team. ' +
        'Run `veilio team unlock` again. Nothing was uploaded.\n'
    )
    return EXIT_ERROR
  }
  if (found.status === 'unavailable') {
    io.stderr(
      `veilio: could not read the team's maps (${found.reason}), so whether this map ` +
        'conflicts with the team cannot be known. Nothing was uploaded.\n'
    )
    return EXIT_ERROR
  }

  // 3. The conflict check. Before sealing, so a refusal costs nothing.
  const clashes = conflictsWithTeam(map, found.analysis.namespace)
  if (clashes.length > 0) {
    io.stderr(
      `veilio: ${clashes.length} placeholder${clashes.length === 1 ? '' : 's'} in this map already ` +
        `mean something else to the team. Publishing would leave ${clashes.length === 1 ? 'it' : 'them'} ` +
        `unrestorable for every member, so nothing was uploaded:\n`
    )
    for (const { placeholder, mine, theirs } of clashes.slice(0, 10)) {
      io.stderr(`  ${placeholder}: this map says ${mine}, the team says ${theirs}\n`)
    }
    if (clashes.length > 10) io.stderr(`  … and ${clashes.length - 10} more\n`)
    io.stderr(
      'Re-run `veilio scrub --team` to number this project out of the team\u2019s own ' +
        'allocation, then push the result.\n'
    )
    return EXIT_ERROR
  }

  // 4. Seal and upload. Nothing above this line has sent anything.
  const envelope = await encryptTeamMap(teamKey, map)
  let created: { id: string }
  try {
    created = await createMap(credential, {
      name: name ?? 'from the terminal',
      map_data: JSON.stringify(envelope),
      identifier_count: Object.keys(map).length,
      scope: 'team',
      key_version: newest.version,
    })
  } catch (err) {
    return reportTeamWriteFailure(err, io)
  }

  // The local map is NOT rewritten with a remote id: a team map is not this
  // project's copy of anything, and recording it as `remote` would make the
  // next `maps pull` treat the team's map as this project's own.
  const total = Object.keys(found.analysis.namespace).length + Object.keys(map).length
  const disputed = Object.keys(found.analysis.conflicts).length
  io.stdout(
    `Published ${Object.keys(map).length} symbols to the team as ${created.id}\n` +
      `The team's shared set now holds about ${total} identifiers` +
      (disputed > 0
        ? `, ${disputed} of which ${disputed === 1 ? 'is' : 'are'} disputed and will not restore\n`
        : ', none disputed\n')
  )
  return EXIT_OK
}

/**
 * Remove a map from Cloud.
 *
 * Who may remove a team map is the server's decision and is not second-guessed
 * here - this says what each refusal means and changes nothing locally either
 * way. Renaming and removing are allowed while a key rotation is owed, because
 * neither stores anything under the key.
 */
export async function runMapsRm(id: string | null, io: Io): Promise<number> {
  const credential = readCredential(io.home)
  if (!credential) return notSignedIn(io)

  if (!id) {
    io.stderr('veilio: which map? Run `veilio maps list` for the ids.\n')
    return EXIT_ERROR
  }

  try {
    await deleteMap(credential, id)
  } catch (err) {
    if (err instanceof CloudError && err.status === 404) {
      io.stderr(`veilio: there is no map ${id} on this account.\n`)
      return EXIT_ERROR
    }
    if (err instanceof CloudError && err.status === 403) {
      io.stderr(`veilio: ${id} belongs to someone else on your team, so it is theirs to remove.\n`)
      return EXIT_ERROR
    }
    return reportCloudFailure(err, io)
  }

  io.stdout(`Removed ${id}\n`)
  return EXIT_OK
}

/**
 * A failed team-map write, said in terms of what happened and who can fix it.
 *
 * The person reading this is often not the person who can clear it: a rotation
 * is owed by whoever holds the current key, not by whoever happened to push.
 * An unexplained refusal in a terminal reads as a broken tool (spec 011 US3).
 */
function reportTeamWriteFailure(err: unknown, io: Io): number {
  if (err instanceof CloudError && err.status === 409) {
    io.stderr(
      'veilio: a teammate left while holding the team key, so no new team content may be ' +
        'written until the key is changed. A member who holds the current key has to do ' +
        'that — it cannot be done from here. Nothing was uploaded.\n'
    )
    return EXIT_ERROR
  }
  if (err instanceof CloudError && err.status === 413) {
    io.stderr(
      'veilio: this map is too large for Cloud to accept, so nothing was stored. ' +
        'Split it, or remove entries you no longer need.\n'
    )
    return EXIT_ERROR
  }
  if (err instanceof CloudError && err.kind === 'forbidden' && /limit/i.test(err.message)) {
    // The ceiling is an abuse limit, not a plan feature. Saying "upgrade" here
    // would take money for a change that does nothing.
    io.stderr(
      `veilio: ${err.message}\nThis ceiling is the same on every paid plan, so upgrading ` +
        'will not raise it. Nothing was uploaded.\n'
    )
    return EXIT_ERROR
  }
  return reportCloudFailure(err, io)
}
