// The commands that reach the network: login, logout, whoami.
//
// Deliberately NOT in commands.ts. That module is the local command path, and
// `offline.test.ts` walks its import graph and fails if it can reach `cloud.ts`
// — which is the structural half of the promise that `veilio scrub` on a laptop
// with no account touches nothing (FR-002). Putting these here is what keeps
// that walk meaningful instead of something to be deleted the moment it becomes
// inconvenient.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  CloudError,
  startDeviceLogin,
  exchangeDeviceCode,
  reservePlaceholders,
  getUserKeys,
  getTeamKeyWraps,
  getMe,
  getMyTeam,
  listMaps,
  listRules,
  request,
} from './cloud.js'
import { unwrapTeamKey, exportTeamKey, type TeamLayer } from '@veilio-inc/engine'
import { ensureBlocks } from './client/blocks.js'
import {
  localDroppedNote,
  outOfRangeNote,
  printable,
  reservationRefusedSentence,
  unvouchedNote,
} from './reservations.js'
import { resolveTeamNamespace, teamLayerNote } from './team-namespace.js'
import {
  readTeamUnlock,
  removeTeamUnlock,
  writeTeamUnlock,
  teamUnlockPath,
  expiryFrom,
  type StoredTeamKey,
  type TeamUnlock,
} from './team-unlock.js'
import {
  readCredential,
  readTeamRecord,
  removeCredential,
  writeCredential,
  writeTeamRecord,
  type Credential,
} from './credential.js'
import { mergeRules, purgeRules, removeRules, rulesPath, writeRules } from './rules.js'
import { openFetchedRules } from './rules-open.js'
import { teamKeyBytes, teamKeyUnconfirmed, teamKeyVersion } from './hashed-bases.js'
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
import { refusal, renderRefusal, rulesSkippedSentences, type Refusal } from './client/wording.js'
import { bootstrapTeamKey, openOwnKeypair } from './client/team-key-bootstrap.js'
import { vaultLock, vaultUnlock } from './client/keys.js'
import { vaultKeyFor } from './client/vault-key.js'
import { fingerprint, sameFingerprint } from './client/fingerprint.js'
import { DELETED_GRANTER, granterIdentity, judgeWrap, wrapFrom } from './client/wrap-judge.js'
import {
  KeyPinsDamaged,
  blockedMark,
  confirmPin,
  confirmedKeys,
  pinOf,
  readPins,
  settleBlockedMark,
} from './key-pins.js'
import {
  formatProjectsList,
  listTeamProjects,
  useProject,
  usedSentence,
} from './client/projects.js'
import {
  PROJECT_ENV,
  overriddenSentence,
  projectOverride,
  type Env,
} from './client/project-scope.js'
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
      writeCredential(keptProject({ token, account, instance: base }, io), io.home)
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

/**
 * A new sign-in keeps the project chosen under the previous one only when it
 * is the same account on the same instance (spec 052, founder 2026-10-25).
 * A project id from another account or instance means nothing here, and
 * keeping it would point every team map call at somebody else's choice. It is
 * dropped, and that is said, so nobody wonders why they are back to every
 * project's maps.
 */
function keptProject(next: Credential, io: Io): Credential {
  const prior = readCredential(io.home)
  if (!prior?.project) return next
  if (prior.instance === next.instance && prior.account === next.account) {
    return { ...next, project: prior.project }
  }
  io.stderr(
    `veilio: project ${prior.project} was chosen for ${prior.account} on ${prior.instance}, so it does not ` +
      'carry over to this sign-in. Run `veilio projects use <name>` to choose one.\n'
  )
  return next
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

  writeCredential(keptProject(credential, io), io.home)
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
  // Still no request: the variable is reported as set, not resolved - which
  // project it names is `veilio projects`'s question, and needs the network.
  const override = projectOverride(io.env)
  io.stdout(
    `${credential.account} on ${credential.instance}` +
      (override
        ? `, project ${override} (from ${PROJECT_ENV})`
        : credential.project
          ? `, project ${credential.project}`
          : '') +
      '\n'
  )
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
    env: io.env,
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
  const { maps, project, projectFromEnv } = listed.value
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
    io.stderr(
      projectFromEnv
        ? `veilio: team maps of project ${project} - ${PROJECT_ENV} chose it, so \`veilio projects use\` does not change it here\n`
        : `veilio: team maps of project ${project} (\`veilio projects\` to change)\n`
    )
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
  const { name, count, path, blocks, localDropped, outOfRange, unvouched } = pulled.value
  io.stdout(`Pulled "${name}" (${count} symbols) into ${path}\n`)
  if (localDropped) io.stdout(`veilio: ${localDroppedNote(localDropped)}\n`)
  if (outOfRange) io.stdout(`veilio: ${outOfRangeNote(outOfRange)}\n`)
  if (unvouched) io.stdout(`veilio: ${unvouchedNote(unvouched)}\n`)
  // Spec 063: what the guard will number new names from.
  if (blocks?.status === 'reserved' && Object.keys(blocks.blocks).length)
    io.stdout(
      `Reserved team numbers for new names: ${Object.entries(blocks.blocks)
        .map(([base, b]) => `${base}${b.start}-${b.end}`)
        .join(', ')}\n`
    )
  // Spec 066 R8: on the normal output - in the 065 benchmark nobody read stderr.
  if (blocks?.status === 'failed')
    io.stdout(`veilio: ${reservationRefusedSentence(blocks, blocks.tag)}\n`)
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

  const { personal, team, skipped } = await openFetchedRules(fetched, credential, io.home)
  const rules = mergeRules(personal, team)
  writeRules(
    {
      instance: credential.instance,
      account: credential.account,
      pulledAt: new Date().toISOString(),
      rules,
      skipped,
    },
    io.home
  )
  const disabled = personal.length + team.length - rules.length
  io.stdout(
    `Pulled ${rules.length} custom rule${rules.length === 1 ? '' : 's'} ` +
      `(${personal.length} personal, ${team.length} team${disabled > 0 ? `, ${disabled} disabled and skipped` : ''}). ` +
      '`veilio scrub` applies them.\n'
  )
  // Not an error: masking works without them, and the fix is one command away.
  for (const sentence of rulesSkippedSentences(skipped)) io.stdout(`${sentence}\n`)
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
export async function runTeamUnlock(
  io: Io,
  days?: number,
  mapPath?: string,
  forgetRefused = false
): Promise<number> {
  const credential = readCredential(io.home)
  if (!credential) {
    io.stderr('veilio: not signed in. Run `veilio login` first.\n')
    return EXIT_ERROR
  }

  try {
    const list = await listMaps(credential)
    const teamId = list.team?.id
    if (teamId) writeTeamRecord({ ...credential, teamId }, io.home)
    if (!teamId) {
      io.stderr(
        'veilio: this account is not in a team, so there are no team keys to unlock. ' +
          'Shared placeholders are a Team-plan feature.\n'
      )
      return EXIT_ERROR
    }

    const mine = await getUserKeys(credential)
    // No keypair: there is nothing to unwrap a team key with, nor to wrap a
    // first one to. The web app makes it on the first vault unlock.
    if (!mine.initialized) return refused(refusal('keys_not_set_up'), io)

    let { wraps } = await getTeamKeyWraps(credential, teamId)

    const derived = await vaultKeyFor(credential, clientContext(io).passphrase)
    if (!derived.ok) return refused(derived.refusal, io)
    const vaultKey = derived.value

    // The keypair, and its public half computed from the private one: a
    // public key the server hands back is never trusted on its own word, not
    // for a wrap's context and above all not for wrapping a key to (security
    // review). A server answer that differs stops everything.
    const own = await openOwnKeypair(vaultKey, mine.privateKeyEncrypted, mine.publicKey)
    if (!own.ok) return refused(refusal('own_public_key_mismatch'), io)
    const privateKey = own.privateKey
    const myPublicKey = own.publicKey

    // None held here: the team may have no key at all - a team of one always
    // starts that way - so try to mint its first one, as the web app does.
    // The server says whether that is a bootstrap; a refusal means a key
    // exists (or this member may not start one), never a reason to mint again.
    let minted: { version: number } | null = null
    if (wraps.length === 0) {
      const tried = await bootstrapTeamKey(credential, teamId, {
        privateKey,
        publicKey: myPublicKey,
      })
      if (tried.status === 'readback_mismatch')
        return refused(refusal('team_key_readback_mismatch'), io)
      if (tried.status === 'refused') {
        if (tried.reason && /owner or an admin/i.test(tried.reason))
          return refused(refusal('team_key_not_startable', { detail: tried.reason }), io)
        // A team of one has nobody to ask, and must not be told to.
        if (await isTeamOfOne(credential)) {
          return refused(
            refusal('team_key_solo_unavailable', {
              detail: tried.reason ?? 'the server did not accept a first key',
            }),
            io
          )
        }
        return refused(refusal('team_key_waiting'), io)
      }
      minted = { version: tried.version }
      // Read back, rather than trusting what was sent: the unwrap below is the
      // proof that what the server now holds opens for this account.
      ;({ wraps } = await getTeamKeyWraps(credential, teamId))
    }

    // Who made each wrap decides whether a map may be sealed under its key
    // (spec 080 item 7a, `client/wrap-judge.ts`). Our own id is what rule 3
    // needs; without it a wrap labelled as ours cannot be told from a first
    // sighting, so nothing is judged at all.
    const ownId = (await getMe(credential)).user?.id
    if (typeof ownId !== 'string' || ownId === '') {
      io.stderr(
        'veilio: Cloud did not say which account this is, so no team key was judged. Nothing was written.\n'
      )
      return EXIT_ERROR
    }
    // Who is on the team now decides whether a confirmed key may be WRITTEN
    // under, as in the web app; it never makes a key trusted. Unknown, it
    // cannot be decided, so nothing is.
    const roster = await teamRoster(credential, teamId)
    if (!roster) {
      io.stderr(
        "veilio: Cloud did not list the team's members, so no team key was judged. Nothing was written.\n"
      )
      return EXIT_ERROR
    }
    const teamName = roster.name ?? printable(teamId)
    const pins = readPins(credential, io.home)
    // The highest version refused before (spec 080 review): kept beside the
    // pins, so a later answer leaving it out, a logout or `team lock` does
    // not lift it. `--forget-refused` is the way out when the team really
    // removed it. Unknown, nothing is stored.
    const pinsDamaged = (err: unknown): number => {
      if (!(err instanceof KeyPinsDamaged)) throw err
      io.stderr(
        `veilio: ${err.path} is damaged, so no team key was stored. Move it aside and run \`veilio team unlock\` again.\n`
      )
      return EXIT_ERROR
    }
    let storedMark: number | undefined
    try {
      storedMark = blockedMark(credential, teamId, io.home)
    } catch (err) {
      return pinsDamaged(err)
    }
    const mark = forgetRefused ? undefined : storedMark

    const keys: StoredTeamKey[] = []
    let refusedAny = false
    // The newest version not stored, for `blockedVersion`.
    let notStored: number | undefined
    const skip = (version: number) => {
      notStored = Math.max(notStored ?? version, version)
    }
    for (const wrap of wraps) {
      let key: string
      try {
        const teamKey = await unwrapTeamKey(wrap.wrapped_key, privateKey, {
          teamId,
          version: wrap.version,
          myPublicKey,
        })
        key = await exportTeamKey(teamKey)
      } catch {
        // A wrap this account cannot open — from a granter whose key has since
        // changed, most likely. Skipped rather than fatal: another version may
        // still open most of the team's maps, and none opening is reported below.
        skip(wrap.version)
        continue
      }
      const from = wrapFrom(wrap.wrapped_key)
      const judged = judgeWrap({
        from,
        wrappedBy: wrap.wrapped_by,
        ownPublicKey: myPublicKey,
        ownId,
        pins,
      })
      if (judged.verdict === 'unreadable' || !from) {
        skip(wrap.version)
        continue
      }
      if (judged.verdict === 'refused-impersonation') {
        io.stderr(
          `Team "${teamName}": key version ${wrap.version} claims to come from your own key but does not. ` +
            'It was not stored. Tell your team administrator and support@veilio.dev.\n'
        )
        refusedAny = true
        skip(wrap.version)
        continue
      }
      const granter = granterLabel(wrap.wrapped_by, roster.emails)
      if (judged.verdict === 'refused-change') {
        io.stderr(
          `Team "${teamName}": ${granter}'s key changed from ${await fingerprint(judged.pinned!)} to ${await fingerprint(from)}. ` +
            'This happens when they reset their key - or when someone else is posing as them. ' +
            `Compare the new fingerprint with ${granter} before you run \`veilio team trust\`. ` +
            'Until then nothing is written under this key.\n'
        )
        refusedAny = true
        skip(wrap.version)
        continue
      }
      const id = granterIdentity(from, wrap.wrapped_by)
      const granterId = id.startsWith('key:') ? null : id
      // A key of our own writes whoever the server lists; anyone else's only
      // while they are an active member (the web app's review 4).
      const current = from === myPublicKey || (granterId !== null && roster.current.has(granterId))
      keys.push({
        version: wrap.version,
        key,
        granter: { id: granterId, publicKey: from, label: granter, current },
        writable: judged.verdict === 'trusted' && current,
      })
      if (!current) {
        io.stdout(`${formerMemberLine(teamName, wrap.version, granter)}\n`)
      } else if (judged.verdict === 'needs-review') {
        const fp = await fingerprint(from)
        io.stdout(
          `Team "${teamName}": key version ${wrap.version} was granted by ${granter} with key ${fp}. ` +
            'You have not confirmed this key on this device, so Veilio can read with it but will not write under it. ' +
            `Ask ${granter} for the key fingerprint Veilio shows them on their dashboard under "Your key fingerprint", ` +
            `and if it matches, run: veilio team trust ${teamArg(teamName, teamId)} ${fp}\n`
        )
      }
    }

    // Raised by what was refused now, kept from before, and lifted only by a
    // version at least as new stored writable.
    let high = notStored === undefined ? mark : Math.max(mark ?? notStored, notStored)
    if (high !== undefined && keys.some((k) => k.writable && k.version >= high!)) high = undefined
    // Settled against the file as it is now: what this run clears is only
    // the mark it read, so a raise another unlock made meanwhile survives.
    const clearUpTo = forgetRefused || high === undefined ? storedMark : undefined
    let settled: number | undefined
    try {
      if (clearUpTo !== undefined || high !== undefined)
        settled = settleBlockedMark(credential, teamId, { clearUpTo, raise: high }, io.home)
    } catch (err) {
      return pinsDamaged(err)
    }
    const blockedVersion =
      settled !== undefined && settled > Math.max(...keys.map((k) => k.version))
        ? settled
        : undefined
    if (blockedVersion !== undefined && notStored !== blockedVersion)
      io.stdout(
        `Team "${teamName}": key version ${blockedVersion} was offered to this account before and not stored, so nothing is written under an older key. ` +
          'If your team removed that version, run: veilio team unlock --forget-refused\n'
      )

    // Refused, not unopenable: the lines above said what to do instead.
    if (keys.length === 0 && refusedAny) return EXIT_ERROR
    if (keys.length === 0) {
      io.stderr(
        'veilio: none of the team key wraps held for this account could be opened. ' +
          'Grant it again from the team page in the web app, then run `veilio team unlock` again.\n'
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
        ...(roster.name ? { teamName: roster.name } : {}),
        ...(blockedVersion !== undefined ? { blockedVersion } : {}),
        expiresAt,
        keys,
      },
      io.home
    )

    const versions = keys.map((k) => `v${k.version}`).join(', ')
    if (minted) {
      io.stdout(
        `Set up the team key (v${minted.version}): the team had none, so this account made its first one ` +
          'and holds it. It was never sent anywhere unwrapped.\n'
      )
    }
    io.stdout(
      `Unlocked ${keys.length === 1 ? 'the team key' : 'team keys'} (${versions}) until ` +
        `${expiresAt}.\n` +
        `Stored in ${teamUnlockPath(io.home)}, readable only by you. ` +
        `Run \`veilio team lock\` to remove them.\n`
    )
    // Spec 063: a project that already has a map gets this member's block of
    // the team's numbers now, so the guard numbers where no teammate can even
    // before a team map is pulled. Never the home directory's own store (the
    // credential lives there), never a store created here.
    if (
      teamId &&
      mapPath &&
      existsSync(mapPath) &&
      dirname(mapPath) !== join(io.home ?? homedir(), '.veilio')
    ) {
      const blocks = await ensureBlocks(credential, teamId, mapPath, io.home)
      if (blocks.status === 'reserved' && Object.keys(blocks.blocks).length)
        io.stdout(
          `Reserved team numbers for new names: ${Object.entries(blocks.blocks)
            .map(([base, b]) => `${base}${b.start}-${b.end}`)
            .join(', ')}\n`
        )
      if (blocks.status === 'failed')
        io.stdout(`veilio: ${reservationRefusedSentence(blocks, blocks.tag)}\n`)
    }
    return EXIT_OK
  } catch (err) {
    return reportCloudFailure(err, io)
  }
}

/**
 * The team's name, its members' addresses (for the messages) and who is an
 * active member now (for writing only: never an input to whether a key is
 * trusted, spec 080 item 7a). Null when it cannot be read, or is another
 * team's.
 */
async function teamRoster(
  credential: Credential,
  teamId: string
): Promise<{ name: string | null; emails: Map<string, string>; current: Set<string> } | null> {
  const emails = new Map<string, string>()
  const current = new Set<string>()
  try {
    const team = (await getMyTeam(credential)).team
    if (team?.id !== teamId) return null
    for (const m of team.members ?? []) {
      const { user_id, email, status } = (m ?? {}) as {
        user_id?: unknown
        email?: unknown
        status?: unknown
      }
      if (typeof user_id !== 'string') continue
      if (typeof email === 'string') emails.set(user_id, printable(email))
      if (status === 'active') current.add(user_id)
    }
    // The server's words, printed to a terminal and kept for later messages:
    // no control, bidi or zero-width character survives (`printable`).
    return {
      name: typeof team.name === 'string' && team.name !== '' ? printable(team.name) : null,
      emails,
      current,
    }
  } catch {
    return null
  }
}

/** A key that reads and will not write: its granter is not on the team now. */
function formerMemberLine(teamName: string, version: number, granter: string): string {
  return (
    `Team "${teamName}": key version ${version} was granted by ${granter}, who is no longer in the team, ` +
    'so Veilio can read with it but will not write under it.'
  )
}

/** Who made a wrap, in words: their address, else their id. */
function granterLabel(wrappedBy: string | undefined, emails: Map<string, string>): string {
  if (wrappedBy === undefined || wrappedBy === DELETED_GRANTER) return 'a deleted account'
  return emails.get(wrappedBy) ?? printable(wrappedBy)
}

/** The team as `team trust` takes it, safe to copy into a shell: its name,
 *  else its id, when that is letters, digits, `.`, `_` and `-` (not first);
 *  else the id single-quoted. Both come from the server. */
export function teamArg(name: string, id: string): string {
  const plain = (s: string) => /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(s)
  if (plain(name)) return name
  const shown = printable(id)
  return plain(shown) ? shown : `'${shown.replace(/'/g, "'\\''")}'`
}

/**
 * `veilio team trust <team> <fingerprint>` (spec 080 item 7a): a person has
 * compared the fingerprint with the granter outside Veilio. Records the pin,
 * then marks writable each stored key that granter made with that key. Reads
 * and writes only this machine's files: nothing is asked of the server, which
 * is the party this check exists to not believe.
 */
export async function runTeamTrust(
  team: string | null,
  typed: string | null,
  io: Io
): Promise<number> {
  const credential = readCredential(io.home)
  if (!credential) {
    io.stderr('veilio: not signed in. Run `veilio login` first.\n')
    return EXIT_ERROR
  }
  if (!team || !typed) {
    io.stderr(
      'veilio: team trust needs the team and the fingerprint: veilio team trust <team> <fingerprint>\n'
    )
    return EXIT_ERROR
  }
  const unlock = readTeamUnlock(credential, io.home)
  const forTeam = unlock !== null && (team === unlock.teamId || team === unlock.teamName)
  let match: NonNullable<StoredTeamKey['granter']> | null = null
  for (const k of forTeam ? unlock.keys : []) {
    if (k.granter && sameFingerprint(typed, await fingerprint(k.granter.publicKey))) {
      match = k.granter
      break
    }
  }
  if (!match) {
    // Not on this machine - a changed key (row 4) is never stored. The wraps
    // are asked for again; what makes one trusted is still the person's
    // comparison of its fingerprint, recorded here, never the server's word.
    const offered = await offeredWrap(credential, team, typed)
    if (!offered) {
      io.stderr(
        `No key for team "${printable(team)}" has the fingerprint ${printable(typed)}. ` +
          'Check it for typos; run `veilio team unlock` to see the fingerprints offered.\n'
      )
      return EXIT_ERROR
    }
    if (!confirmed(() => confirmPin(credential, offered.identity, offered.publicKey, io.home), io))
      return EXIT_ERROR
    // The unlock judges every wrap again with the new pin and stores the key.
    const code = await runTeamUnlock(io)
    const after = readTeamUnlock(credential, io.home)
    if (code === EXIT_OK && after) await printConfirmed(after, offered.publicKey, io, false)
    return code
  }

  const identity = granterIdentity(match.publicKey, match.id)
  if (!confirmed(() => confirmPin(credential, identity, match.publicKey, io.home), io))
    return EXIT_ERROR
  const accepted = confirmedKeys(pinOf(readPins(credential, io.home), identity))
  // Re-judged: what this granter made with a key now confirmed may be written
  // under. Nothing becomes unwritable - a confirmation keeps the earlier keys.
  const keys = unlock!.keys.map((k) =>
    k.granter &&
    k.granter.current === true &&
    granterIdentity(k.granter.publicKey, k.granter.id) === identity &&
    accepted.includes(k.granter.publicKey)
      ? { ...k, writable: true }
      : k
  )
  const updated = { ...unlock!, keys }
  writeTeamUnlock(updated, io.home)
  await printConfirmed(updated, match.publicKey, io, true)
  return EXIT_OK
}

/** Run a pin write; a damaged key-pins.json is said, never thrown. */
function confirmed(write: () => void, io: Io): boolean {
  try {
    write()
    return true
  } catch (err) {
    if (!(err instanceof KeyPinsDamaged)) throw err
    io.stderr(
      `veilio: ${err.path} is damaged, so the key was not confirmed. Move it aside and run \`veilio team trust\` again.\n`
    )
    return false
  }
}

/** Row 6 for each stored key made with `publicKey` that may now be written
 *  under; with `formerToo`, the read-only line for the others. */
async function printConfirmed(
  unlock: TeamUnlock,
  publicKey: string,
  io: Io,
  formerToo: boolean
): Promise<void> {
  const teamName = printable(unlock.teamName ?? unlock.teamId)
  const fp = await fingerprint(publicKey)
  for (const k of unlock.keys) {
    const g = k.granter
    if (g?.publicKey !== publicKey) continue
    const who =
      typeof g.label === 'string'
        ? printable(g.label)
        : g.id === null
          ? 'a deleted account'
          : printable(g.id)
    if (k.writable)
      io.stdout(
        `Confirmed ${fp} for ${who} on this device. Team "${teamName}" key version ${k.version} can now be used to save maps.\n`
      )
    else if (formerToo) io.stdout(`${formerMemberLine(teamName, k.version, who)}\n`)
  }
}

/**
 * The wrap Cloud holds for this account whose granter key has the typed
 * fingerprint, for the team named. Null when there is none, or Cloud cannot be
 * asked. Never one labelled as this account: that is rule 3's refusal, and
 * confirming it would pin the server's key under our own name.
 */
async function offeredWrap(
  credential: Credential,
  team: string,
  typed: string
): Promise<{ identity: string; publicKey: string } | null> {
  try {
    const teamId = (await listMaps(credential)).team?.id
    if (!teamId) return null
    const roster = await teamRoster(credential, teamId)
    if (team !== teamId && team !== roster?.name) return null
    const ownId = (await getMe(credential)).user?.id
    if (typeof ownId !== 'string' || ownId === '') return null
    for (const wrap of (await getTeamKeyWraps(credential, teamId)).wraps) {
      const from = wrapFrom(wrap.wrapped_key)
      if (!from || wrap.wrapped_by === ownId) continue
      if (sameFingerprint(typed, await fingerprint(from)))
        return { identity: granterIdentity(from, wrap.wrapped_by), publicKey: from }
    }
    return null
  } catch {
    return null
  }
}

/**
 * `veilio keys fingerprint` (spec 080 item 7a): what a teammate compares when
 * they confirm a key this account granted. The fingerprint of the public key
 * DERIVED from the private key the passphrase opens, never the server's copy
 * - a server that swapped it would otherwise make both sides agree, as the web
 * app's `OwnFingerprint` says.
 */
export async function runKeysFingerprint(io: Io): Promise<number> {
  const credential = readCredential(io.home)
  if (!credential) {
    io.stderr('veilio: not signed in. Run `veilio login` first.\n')
    return EXIT_ERROR
  }
  try {
    const mine = await getUserKeys(credential)
    if (!mine.initialized) return refused(refusal('keys_not_set_up'), io)
    const derived = await vaultKeyFor(credential, clientContext(io).passphrase)
    if (!derived.ok) return refused(derived.refusal, io)
    const own = await openOwnKeypair(derived.value, mine.privateKeyEncrypted, mine.publicKey)
    if (!own.ok) return refused(refusal('own_public_key_mismatch'), io)
    io.stdout(
      `Your key fingerprint: ${await fingerprint(own.publicKey)}. ` +
        'Teammates compare this when they confirm a key you granted.\n'
    )
    return EXIT_OK
  } catch (err) {
    return reportCloudFailure(err, io)
  }
}

/** Whether this account is its team's only member. Unknown counts as not:
 *  the general wording is still true for a team of one, just less helpful. */
async function isTeamOfOne(credential: Credential): Promise<boolean> {
  try {
    const members = (await getMyTeam(credential)).team?.members
    return Array.isArray(members) && members.length === 1
  } catch {
    return false
  }
}

/** Remove the unlocked team keys, and the team rules opened with them. */
export function runTeamLock(io: Io): number {
  try {
    io.stdout(removeTeamUnlock(io.home) ? 'Team keys locked.\n' : 'No team keys were unlocked.\n')
  } catch (err) {
    io.stderr(
      `veilio: the unlocked team keys could not be removed ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `Delete ${teamUnlockPath(io.home)} by hand.\n`
    )
    return EXIT_ERROR
  }
  // One team-keys file holds one team, so every cached team rule was that team's.
  return purgeLockedRules('team', io)
}

/**
 * Lock means the opened rules go too (spec 065 FR-006): purged from the cache
 * even when no key was on disk - one that expired or was deleted by hand still
 * left them readable there.
 */
function purgeLockedRules(scope: 'personal' | 'team', io: Io): number {
  let n: number
  try {
    n = purgeRules(scope, io.home)
  } catch (err) {
    io.stderr(
      `veilio: the cached ${scope} custom rules could not be removed ` +
        `(${err instanceof Error ? err.message : String(err)}). Delete ${rulesPath(io.home)} by hand.\n`
    )
    return EXIT_ERROR
  }
  if (n > 0)
    io.stdout(
      `${n} ${scope} custom rule${n === 1 ? '' : 's'} removed from this machine until the next ` +
        `\`veilio ${scope === 'team' ? 'team' : 'vault'} unlock\` and \`veilio rules pull\`.\n`
    )
  return EXIT_OK
}

// ─── projects ────────────────────────────────────────────────────────────────

/** The team's projects, the one in use marked with `*`. */
export async function runProjectsList(io: Io): Promise<number> {
  const listed = await listTeamProjects(clientContext(io))
  if (!listed.ok) return refused(listed.refusal, io)
  const { lines, note } = formatProjectsList(listed.value, { surface: 'cli' })
  for (const line of lines) io.stdout(`${line}\n`)
  if (note) io.stderr(`veilio: ${note}\n`)
  return EXIT_OK
}

/** Choose the project this sign-in works in. */
export async function runProjectsUse(ref: string | null, io: Io): Promise<number> {
  const used = await useProject(clientContext(io), ref)
  if (!used.ok) return refused(used.refusal, io)
  io.stdout(`${usedSentence(used.value, { surface: 'cli' })}\n`)
  if (used.value.overriddenBy !== null)
    io.stderr(`veilio: ${overriddenSentence(used.value, 'shell')}\n`)
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

/** Remove the personal-maps key from this machine, and the personal rules opened with it. */
export function runVaultLock(io: Io): number {
  try {
    io.stdout(
      vaultLock(clientContext(io))
        ? 'Personal-maps key locked.\n'
        : 'No personal-maps key was unlocked.\n'
    )
  } catch (err) {
    io.stderr(
      `veilio: the personal-maps key could not be removed ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `Delete ${personalMapsKeyPath(io.home)} by hand.\n`
    )
    return EXIT_ERROR
  }
  return purgeLockedRules('personal', io)
}

// ─── restore: the team layer ────────────────────────────────────────────────

/**
 * The team's maps for `veilio restore` (spec 028), handed to the local command
 * as a callback so that command stays unlinked from the network. Signed out:
 * no request, no layer - a local restore, as before.
 */
export async function teamLayerFor(
  home: string | undefined,
  missing: readonly string[],
  env?: Env
): Promise<{
  team: TeamLayer | null
  note: string | null
  refused?: string
  misattributed?: string[]
  unissued?: string[]
}> {
  // Signed out, the resolver answers 'local' without a request. At most 5 s: a
  // hung instance must not stall a `... | veilio restore > file` pipeline.
  const found = await resolveTeamNamespace(home, { deadlineMs: RESTORE_CLOUD_WAIT_MS, env })
  if (found.status === 'refused')
    return { team: null, note: null, refused: renderRefusal(found.refusal) }
  if (found.status === 'team' && found.conflictDetection)
    return {
      team: found.analysis,
      note: null,
      misattributed: found.misattributed ?? [],
      unissued: found.unissued ?? [],
    }
  return { team: null, note: teamLayerNote(found, missing) }
}

const RESTORE_CLOUD_WAIT_MS = 5000

/** What `veilio scrub` numbers from (spec 030): the team's namespace, or this
 *  project's map with the reason. Signed out or in no team: no request, no note. */
export async function teamNamespaceForScrub(
  home: string | undefined,
  env?: Env
): Promise<Awaited<ReturnType<TeamNamespaceSource>>> {
  const found = await resolveTeamNamespace(home, { deadlineMs: RESTORE_CLOUD_WAIT_MS, env })
  if (found.status === 'refused')
    return { team: null, note: null, refused: renderRefusal(found.refusal) }
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
      numberingTeam: teamId,
      // A refused rule base refuses the scrub, as any failed reservation does.
      reserve: async (requests) => {
        const r = await reservePlaceholders(credential, teamId, requests, undefined, {
          keys: teamKeyBytes(credential, home, teamId),
          keyVersion: teamKeyVersion(credential, home, teamId),
          unconfirmed: teamKeyUnconfirmed(credential, home, teamId),
          ...(found.reservations ? { reservations: found.reservations } : {}),
        })
        if (r.refused) throw new CloudError('forbidden', r.refused.detail)
        return r.ranges
      },
    }
  }
  if (found.status === 'locked')
    return {
      team: null,
      numberingTeam: found.teamId ?? null,
      note: 'the team key is locked on this machine, so names the team already knows may have been given new placeholders; new names were numbered on this machine only (__LOCAL_…). Run `veilio team unlock`, then scrub again.',
    }
  if (found.status === 'unavailable') {
    const credential = readCredential(home)
    return {
      team: null,
      // Which team: the unlock's, else the one last seen; null when never seen,
      // still numbered locally (spec 066 FR-001, code review).
      numberingTeam: credential
        ? (readTeamUnlock(credential, home)?.teamId ?? readTeamRecord(credential, home))
        : undefined,
      note: `could not read the team's maps (${found.reason}), so names the team already knows may have been given new placeholders; new names were numbered on this machine only (__LOCAL_…), and the next team publish renumbers them.`,
    }
  }
  return { team: null, note: null }
}

/** Kept importable from here: tests and callers written before spec 052 moved
 *  it into the shared client. */
export { conflictsWithTeam } from './client/maps.js'
