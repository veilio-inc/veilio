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
  startDeviceLogin,
  exchangeDeviceCode,
  reservePlaceholders,
  getVault,
  getUserKeys,
  getTeamKeyWraps,
  listMaps,
  listRules,
  request,
} from './cloud.js'
import {
  checkVaultVerifier,
  deriveVaultKey,
  unwrapPrivateKey,
  unwrapTeamKey,
  exportTeamKey,
  fromBase64,
  type TeamLayer,
} from '@veilio-inc/engine'
import { resolveTeamNamespace, teamLayerNote } from './team-namespace.js'
import {
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
import {
  createCloudMap,
  listCloudMaps,
  pullCloudMap,
  removeCloudMap,
  updateCloudMap,
  type ClientContext,
} from './client/maps.js'
import { renderRefusal, type Refusal } from './client/wording.js'
import { vaultLock, vaultUnlock } from './client/keys.js'
import { personalMapsKeyPath, removePersonalMapsKey } from './client/personal-maps-key.js'
import { VERSION } from './version.js'

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
/**
 * Sign in by asking a browser to do it (spec 046).
 *
 * The terminal shows a short code; a person approves it in a browser session
 * that has already satisfied whatever that account requires - a CAPTCHA, a
 * second factor, an identity provider - and the terminal exchanges a long code
 * for an ordinary session. Nothing about the account is typed here, so there is
 * nothing here for a CAPTCHA to protect.
 */
export async function runDeviceLogin(base: string, io: Io): Promise<number> {
  let start
  try {
    start = await startDeviceLogin(base, `veilio CLI ${VERSION}`)
  } catch (err) {
    return reportLoginFailure(err, io)
  }

  // stderr, so `veilio login` still composes in a pipe: the instructions are
  // for the person, not for whatever is reading stdout.
  io.stderr(
    `\nOpen this page in a browser where you are signed in:\n\n` +
      `  ${start.verification_uri_complete}\n\n` +
      `and confirm the code  ${start.user_code}\n\n` +
      `Waiting for approval. Ctrl-C cancels, and nothing is signed in if you do.\n`
  )

  const deadline = Date.now() + start.expires_in * 1000
  let interval = Math.max(1, start.interval) * 1000

  for (;;) {
    if (Date.now() >= deadline) {
      io.stderr(
        'veilio: that code expired before it was approved. Nothing was signed in — ' +
          'run `veilio login` again for a fresh one.\n'
      )
      return EXIT_ERROR
    }
    await new Promise((resolve) => setTimeout(resolve, interval))

    try {
      const { token } = await exchangeDeviceCode(base, start.device_code)
      // Only now is anything written. Every refusal above leaves this machine
      // exactly as it was (FR-010).
      const account = await accountFor(base, token, io)
      if (account === null) return EXIT_ERROR
      writeCredential({ token, account, instance: base }, io.home)
      io.stdout(`Signed in to ${base} as ${account}\n`)
      return EXIT_OK
    } catch (err) {
      if (!(err instanceof CloudError)) return reportLoginFailure(err, io)
      switch (err.message) {
        case 'authorization_pending':
          continue
        case 'slow_down':
          // Asked to wait longer, not refused. Backing off is the whole point
          // of being told, so a client that ignored this would be the reason
          // the server had to start refusing instead.
          interval += 2000
          continue
        case 'access_denied':
          io.stderr(
            'veilio: that request was declined, so nothing was signed in. If you did not ' +
              'decline it yourself, the browser session that approved it has since been ' +
              'revoked — sign in to the web app again, then re-run `veilio login`.\n'
          )
          return EXIT_ERROR
        case 'expired_token':
          io.stderr(
            'veilio: that code is no longer valid — it expired, or it has already been ' +
              'used. Run `veilio login` again for a fresh one.\n'
          )
          return EXIT_ERROR
        default:
          return reportLoginFailure(err, io)
      }
    }
  }
}

/** Who the new session belongs to, asked of the server rather than assumed. */
async function accountFor(base: string, token: string, io: Io): Promise<string | null> {
  try {
    const me = await request<{ user?: { email?: string } }>('/api/auth/me', {
      instance: base,
      credential: { token, account: '', instance: base },
    })
    const email = me.user?.email
    if (email) return email
  } catch {
    // Fall through: the session is good, we just could not label it.
  }
  io.stderr(
    'veilio: signed in, but this instance did not say which account the session belongs to. ' +
      'Nothing was written, because a credential with no account on it cannot be matched to ' +
      'an unlocked team key later.\n'
  )
  return null
}

export async function runLogin(
  instance: string | null,
  io: Io,
  opts: { device?: boolean } = {}
): Promise<number> {
  const base = instance ?? DEFAULT_INSTANCE

  // Asked for explicitly. The right choice for an account bound by a team's
  // SSO requirement: a password typed here would be accepted by the login
  // route and then refused by every later request, which reads as a broken
  // tool rather than as the wrong way in.
  if (opts.device === true) return runDeviceLogin(base, io)

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
    // The instance requires a CAPTCHA, which this process cannot produce and
    // which no amount of retrying will change. Falling back is not a guess:
    // the refusal names the cause, and the browser flow is the way in that
    // exists for exactly this. Reporting "CAPTCHA verification failed" to
    // somebody who was never shown a CAPTCHA is the version of this that reads
    // as a broken tool.
    if (err instanceof CloudError && /captcha/i.test(err.message)) {
      io.stderr(
        `\nveilio: ${base} requires a browser check that a terminal cannot do, ` +
          'so signing in continues in your browser. Your password was not sent anywhere ' +
          'else and nothing was stored.\n'
      )
      return runDeviceLogin(base, io)
    }
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
        removePersonalMapsKey(io.home)
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
  // The personal-maps key, for the same reason as the team keys.
  try {
    removePersonalMapsKey(io.home)
  } catch (err) {
    io.stderr(
      `veilio: the session was revoked, but the unlocked personal-maps key could not be removed ` +
        `(${err instanceof Error ? err.message : String(err)}). Delete ${personalMapsKeyPath(io.home)} by hand.\n`
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

// ─── maps: list, pull, push, update, rm ──────────────────────────────────────
//
// The work is done in `client/maps.ts`, which the MCP server's map tools call
// too (spec 052 §3). What is left here is the terminal's half: asking for the
// passphrase, and saying what happened - results on stdout, refusals on
// stderr, in the words of the shared table.

/** The client's context for a terminal run: the person can be asked. */
function clientContext(io: Io): ClientContext {
  return {
    home: io.home,
    passphrase: io.password ? () => io.password!('Vault passphrase: ') : undefined,
  }
}

/** A refusal on stderr, and the exit code that goes with it. */
function refused(refusal: Refusal, io: Io): number {
  io.stderr(renderRefusal(refusal))
  return EXIT_ERROR
}

function notes(lines: readonly string[], io: Io): void {
  for (const line of lines) io.stderr(`veilio: ${line}\n`)
}

/**
 * List what the account holds.
 *
 * Prints the id, because `pull` takes one. A name would be friendlier and is
 * wrong: names are not unique, and picking "the first one that matches" is how
 * somebody pulls a different map over the one they were using. A teammate's
 * team map is marked, because it is theirs to update or remove.
 */
export async function runMapsList(io: Io): Promise<number> {
  const listed = await listCloudMaps(clientContext(io))
  if (!listed.ok) return refused(listed.refusal, io)
  const { maps, project } = listed.value
  if (maps.length === 0) {
    io.stdout('No maps in Cloud yet. `veilio maps push <name>` uploads the local one.\n')
    return EXIT_OK
  }
  for (const map of maps) {
    const count = map.count === null ? '?' : String(map.count)
    const whose = map.scope === 'team' && !map.mine ? '  (a teammate’s)' : ''
    io.stdout(
      `${map.id}  ${map.scope.padEnd(8)} ${count.padStart(5)} symbols  ${map.name}${whose}\n`
    )
  }
  // Said on stderr so the listing itself stays parseable: which project's team
  // maps these are, or that no project was chosen.
  if (project)
    io.stderr(`veilio: team maps of project ${project} (\`veilio projects\` to change)\n`)
  return EXIT_OK
}

/**
 * Pull a map into the local store: decrypt FIRST, write second (see
 * `pullCloudMap`). A personal map is opened HERE - the passphrase never leaves
 * this machine, and there is no code path in this package that could send it.
 */
export async function runMapsPull(
  id: string | null,
  mapPath: string,
  io: Io,
  options: { force?: boolean } = {}
): Promise<number> {
  const pulled = await pullCloudMap(clientContext(io), id, { mapPath, force: options.force })
  if (!pulled.ok) return refused(pulled.refusal, io)
  const { name, count, path } = pulled.value
  io.stdout(`Pulled "${name}" (${count} symbols) into ${path}\n`)
  return EXIT_OK
}

/** Upload the local map, personal or the team's. Same endpoint, same quotas,
 *  same validation as the web app. */
export async function runMapsPush(
  name: string | null,
  mapPath: string,
  io: Io,
  toTeam = false
): Promise<number> {
  const created = await createCloudMap(clientContext(io), {
    name,
    scope: toTeam ? 'team' : 'personal',
    mapPath,
  })
  if (!created.ok) return refused(created.refusal, io)
  const c = created.value
  notes(c.notes, io)
  if (c.scope === 'personal') {
    io.stdout(`Pushed ${c.count} symbols to Cloud as ${c.id}\n`)
    return EXIT_OK
  }
  const disputed = c.disputed ?? 0
  io.stdout(
    `Published "${c.name}" (${c.count} symbols) to the team as ${c.id}\n` +
      `The team's shared set now holds ${c.teamTotal} identifiers` +
      (disputed > 0
        ? `, ${disputed} of which ${disputed === 1 ? 'is' : 'are'} disputed and will not restore\n`
        : ', none disputed\n')
  )
  return EXIT_OK
}

/** Replace a Cloud map's entries with the local map's, in place (spec 052). */
export async function runMapsUpdate(
  id: string | null,
  mapPath: string,
  io: Io,
  options: { allowDrop?: boolean } = {}
): Promise<number> {
  const updated = await updateCloudMap(clientContext(io), id, {
    mapPath,
    allowDrop: options.allowDrop,
  })
  if (!updated.ok) return refused(updated.refusal, io)
  const u = updated.value
  notes(u.notes, io)
  io.stdout(
    `Updated "${u.name}" (${u.id}) in place: ${u.count} symbols` +
      (u.dropped > 0 ? `, ${u.dropped} dropped as asked` : '') +
      `${u.scope === 'team' ? ', sealed with the team key' : ''}\n`
  )
  return EXIT_OK
}

/**
 * Remove a map from Cloud. Renaming and removing are allowed while a key
 * rotation is owed, because neither stores anything under the key.
 */
export async function runMapsRm(id: string | null, io: Io): Promise<number> {
  const removed = await removeCloudMap(clientContext(io), id)
  if (!removed.ok) return refused(removed.refusal, io)
  const { name } = removed.value
  io.stdout(name ? `Removed "${name}" (${removed.value.id})\n` : `Removed ${removed.value.id}\n`)
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

// ─── vault: unlock, lock ─────────────────────────────────────────────────────

/**
 * Unlock the personal-maps key for processes that cannot ask for a passphrase
 * (spec 052 FR-011). See `client/keys.ts` for what is kept: that key, and
 * nothing else the vault protects.
 */
export async function runVaultUnlock(io: Io, days?: number): Promise<number> {
  const unlocked = await vaultUnlock(clientContext(io), { days })
  if (!unlocked.ok) return refused(unlocked.refusal, io)
  const u = unlocked.value
  io.stdout(
    `${u.created ? 'Created and unlocked' : 'Unlocked'} the personal-maps key until ${u.expiresAt}.\n` +
      `Stored in ${u.path}, readable only by you. It opens your personal maps and nothing else; ` +
      'the vault passphrase and key were not kept. Run `veilio vault lock` to remove it.\n' +
      (u.resealed > 0
        ? `Re-sealed ${u.resealed} personal map${u.resealed === 1 ? '' : 's'} under it, so the MCP server can open ${u.resealed === 1 ? 'it' : 'them'}.\n`
        : '')
  )
  if (u.failed.length > 0) {
    io.stderr(
      `veilio: ${u.failed.length} personal map${u.failed.length === 1 ? '' : 's'} could not be re-sealed and ` +
        `${u.failed.length === 1 ? 'is' : 'are'} still under the vault key, which the MCP server cannot open:\n` +
        u.failed.map((f) => `  "${f.name}" (${f.id}): ${f.reason}\n`).join('') +
        'Run `veilio vault unlock` again to retry them; the key itself is unlocked.\n'
    )
    return EXIT_ERROR
  }
  return EXIT_OK
}

/** Remove the personal-maps key from this machine. */
export function runVaultLock(io: Io): number {
  try {
    if (!vaultLock(clientContext(io))) {
      io.stdout('No personal-maps key was unlocked.\n')
      return EXIT_OK
    }
  } catch (err) {
    io.stderr(
      `veilio: the personal-maps key could not be removed ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `Delete ${personalMapsKeyPath(io.home)} by hand.\n`
    )
    return EXIT_ERROR
  }
  io.stdout('Personal-maps key locked.\n')
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

/** Kept importable from here: tests and callers written before spec 052 moved
 *  it into the shared client. */
export { conflictsWithTeam } from './client/maps.js'
