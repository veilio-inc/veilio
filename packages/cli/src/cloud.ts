// The network boundary. The ONLY module in this package permitted to make a
// request.
//
// Every other file here is offline by construction, and that is a published
// claim rather than an implementation detail: the CLI makes the same privacy
// promise the web app does, and `veilio scrub` on a laptop with no account must
// touch nothing (FR-001, FR-002).
//
// A promise like that is kept by a boundary somebody can see, not by everyone
// remembering. So the rule is structural and it is enforced twice:
//
//   - `offline.test.ts` walks the import graph from `commands.ts` and fails if
//     this module is reachable from it, including down branches no test drives.
//   - The same file asserts this is the only source in `src/` that names
//     `fetch`, so moving the call somewhere else fails rather than passing.
//
// Which means: if you are adding a request, it goes here. If that feels
// awkward — because the thing you are writing is a local command that suddenly
// needs the network — the awkwardness is the design telling you something.
//
// NOTE (spec 005 Phase 3): this module deliberately has no callers yet. It is
// created ahead of the commands that use it so the boundary exists before
// anything crosses it, and so the tests that police it are written against
// something real. Phase 4 (`login`, `logout`, `whoami`) is what consumes it.

import type { Credential } from './credential.js'
import { VERSION } from './version.js'
import type { CustomRule } from '@veilio-inc/engine'

/** The public Cloud. `--instance` overrides it for a self-hosted deployment. */
export const DEFAULT_INSTANCE = 'https://app.veilio.dev'

/**
 * Which program is talking: the label and the User-Agent every request
 * carries (tracker d12).
 *
 * A burst of requests hit Cloud's rate limit, and nothing said what had sent
 * them, because the MCP server's requests went out through this module
 * labelled `cli`, under Node's default User-Agent. The process that uses this
 * module now says who it is: the CLI by default, and the MCP server by calling
 * `setClientIdentity` when it loads. One identity per process: the two
 * programs never share one.
 *
 * A SELF-REPORT, and that is the whole of it. The server logs it and labels a
 * session with it; it must never decide access, because anyone can set a
 * header.
 */
export interface ClientIdentity {
  client: 'cli' | 'mcp'
  /** `veilio-cli/0.6.0`, `veilio-mcp/0.6.0`. */
  userAgent: string
}

let identity: ClientIdentity = { client: 'cli', userAgent: `veilio-cli/${VERSION}` }

export function setClientIdentity(next: ClientIdentity): void {
  // A header value is printable ASCII; anything else would make every
  // request throw inside fetch, far from here.
  if (!/^[\x20-\x7e]+$/.test(next.userAgent)) {
    throw new Error(`not a usable User-Agent: ${JSON.stringify(next.userAgent)}`)
  }
  identity = { ...next }
}

export function clientIdentity(): ClientIdentity {
  return { ...identity }
}

/** How long any single request may take before we give up on it. */
export const REQUEST_TIMEOUT_MS = 15_000

/**
 * What went wrong, in the terms the user needs to act on.
 *
 * `kind` exists because the remedies differ and a single "request failed" would
 * send people to the wrong one (FR-007):
 *   - `unauthenticated` — the credential is wrong or the session was revoked.
 *     Sign in again.
 *   - `unentitled` — the sign-in worked; the plan does not include this. Nothing
 *     about signing in again will help.
 *   - `suspended` — the account is under review. Export and erasure still work;
 *     nothing else does, and a bigger plan will not change that.
 *   - `forbidden` — authenticated, entitled, and still not allowed: somebody
 *     else's map, or a team role this account does not hold.
 *   - `unreachable` — the instance did not answer. Nothing is wrong with the
 *     account.
 *   - `server` — the instance answered with a failure of its own.
 */
export type CloudErrorKind =
  'unauthenticated' | 'unentitled' | 'suspended' | 'forbidden' | 'unreachable' | 'server'

export class CloudError extends Error {
  constructor(
    readonly kind: CloudErrorKind,
    message: string,
    readonly status?: number,
    /** The failure response's JSON body, when it had one. A 409 on a map
     *  update carries `current_updated_at`, and a refusal that names the
     *  version it lost to needs it (spec 052). */
    readonly body?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'CloudError'
  }
}

export interface RequestOptions {
  /** Base URL of the instance. Defaults to the public Cloud. */
  instance?: string
  /** Bearer credential, when the call needs one. */
  credential?: Credential | null
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

/**
 * One request, with the failure modes already sorted into something actionable.
 *
 * Everything that reaches the network in this package goes through here, so the
 * `X-Veilio-Client` header, the timeout and the error mapping are decided once
 * rather than per call site.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  // The credential's own instance wins, so a token issued by A can never be
  // sent to B. But silently ignoring an explicit `--instance` would be a
  // fallback nobody was told about (Constitution V), so a conflict is refused
  // rather than quietly resolved.
  if (
    options.credential &&
    options.instance &&
    trimSlashes(options.instance) !== trimSlashes(options.credential.instance)
  ) {
    throw new CloudError(
      'unauthenticated',
      `signed in to ${options.credential.instance}; run \`veilio logout\` before using ${options.instance}`
    )
  }
  const base = trimSlashes(options.credential?.instance ?? options.instance ?? DEFAULT_INSTANCE)
  const url = `${base}${path}`

  const headers: Record<string, string> = {
    // What this session gets labelled in the user's sessions list. It is a
    // self-report and the server treats it as one — it must never gate access,
    // or a header anyone can set becomes an authorisation input.
    'X-Veilio-Client': identity.client,
    // Which program and version, for the server's logs (tracker d12). Node's
    // default User-Agent says only "node".
    'User-Agent': identity.userAgent,
    Accept: 'application/json',
  }
  if (options.credential) headers.Authorization = `Bearer ${options.credential.token}`
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  // A hung instance must not hang the terminal.
  //
  // `AbortSignal.any` rather than a hand-rolled controller, for two reasons the
  // manual version got wrong. It honours a signal that is ALREADY aborted — a
  // listener added after the fact never fires, so a cancelled command still put
  // its request on the wire with the bearer token attached. And it drops its
  // own listeners when collected, where the manual `addEventListener` retained
  // one closure per request on a shared signal.
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline

  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
      // An API client has no reason to follow a redirect, and following one is
      // how a bearer token ends up somewhere it was never issued for.
      redirect: 'error',
    })
  } catch (err) {
    // DNS failure, refused connection, TLS problem, timeout. None of them says
    // anything about the account, and reporting them as an auth problem would
    // send someone to re-enter a password that was never the issue.
    throw new CloudError(
      'unreachable',
      `could not reach ${base}: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // The deadline is deliberately still armed. `fetch` resolves as soon as the
  // HEADERS arrive, so a server that answers `200 OK` and then stalls mid-body
  // would hang the terminal for ever under a timer cleared at the line above —
  // which is exactly what "must not hang the terminal" used to promise and not
  // do. Every body read below is tied to the same signal, so a stalled stream
  // aborts with it.

  if (response.status === 401) {
    throw new CloudError(
      'unauthenticated',
      'not signed in, or the session was revoked — run `veilio login`',
      401
    )
  }

  if (response.status === 402 || response.status === 403) {
    // The status alone is not the answer, and treating it as one gets the remedy
    // wrong on exactly the routes this will call. The server answers 403 for a
    // SUSPENDED account (a RODO rights-only state), for a team-role refusal, and
    // for a map belonging to somebody else — while the actual paywall is 402.
    // Rendering all of those as "your plan does not include that" tells a
    // suspended user to go and buy something.
    const body = await bodyOf(response)
    const message = typeof body.error === 'string' && body.error !== '' ? body.error : null
    if (body.suspended === true) {
      throw new CloudError('suspended', message ?? 'this account is suspended', response.status)
    }
    if (response.status === 402 || body.paywall === true || body.upgrade === true) {
      throw new CloudError(
        'unentitled',
        message ?? 'this account’s plan does not include that',
        response.status
      )
    }
    throw new CloudError('forbidden', message ?? 'not permitted on this account', 403, body)
  }

  if (!response.ok) {
    const body = await bodyOf(response)
    throw new CloudError(
      'server',
      typeof body.error === 'string' && body.error !== ''
        ? body.error
        : `${base} returned ${response.status}`,
      response.status,
      body
    )
  }

  // A 204 or an empty body is a legitimate answer — `POST /api/auth/logout` is
  // the obvious one — and `response.json()` throws a bare SyntaxError on it,
  // which escapes every `catch (e) { if (e instanceof CloudError) }` a caller
  // writes and surfaces as a stack trace instead of a message.
  if (response.status === 204) return undefined as T
  const text = await response.text()
  if (text === '') return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new CloudError(
      'server',
      `${base} answered ${response.status} with something that was not JSON`,
      response.status
    )
  }
}

// ─── The map endpoints, as the browser already uses them ─────────────────────
//
// No CLI-shaped API. These call `GET /api/maps`, `GET /api/maps/:id` and
// `POST /api/maps` unchanged, because a route added for a tool is a second place
// for entitlement to be decided — and `cli-maps.test.ts` in the Cloud repo fails
// if the map route table ever grows one.

/** A map as the list endpoint describes it. */
export interface CloudMapSummary {
  id: string
  name: string
  scope: 'personal' | 'team'
  identifier_count: number | null
  /** Ordering key for the team namespace merge — first-write-wins is decided on
   *  this, not on `updated_at`, so a map edited later cannot steal a placeholder
   *  an older map already claimed. */
  created_at: string
  updated_at: string
}

export interface CloudMapList {
  personalMaps: CloudMapSummary[]
  teamMaps: CloudMapSummary[]
  /** Placeholder -> identifier, merged across the team's maps.
   *
   *  **No current Cloud release sends this.** It was dropped when the merge
   *  moved to the clients: producing it server-side meant decrypting every team
   *  map, which was the only reason the server held a key that could read them.
   *  Kept in the type because an older self-hosted Cloud may still send it, and
   *  reading it costs nothing; `undefined` is the expected answer and the
   *  client-side merge is the path that runs (spec 010). */
  teamNamespace?: Record<string, string> | null
  /** The active team, when the account has one. Needed to ask for that team's
   *  key wraps. */
  team: { id: string } | null
  plan: string
}

/** The account's own keypair, as the server holds it.
 *
 *  `privateKeyEncrypted` is wrapped under the vault key, which is derived from
 *  a passphrase the server never receives — so this is a blob the server cannot
 *  open, exactly like a personal map envelope. */
export type UserKeys =
  | { initialized: false }
  | { initialized: true; publicKey: string; privateKeyEncrypted: string; alg: string }

/** One member's copy of a team key, wrapped to their public key. */
export interface TeamKeyWrap {
  version: number
  wrapped_key: string
  wrapped_by: string
  created_at: string
}

/** A single map. `map_data` is an opaque envelope string for a personal map. */
export interface CloudMap extends CloudMapSummary {
  map_data: string | Record<string, string>
}

/** The account's vault parameters. Never the passphrase, never the key. */
export type VaultInfo =
  | { initialized: false }
  | {
      initialized: true
      salt: string
      verifier: string
      kdf?: { name: string; iterations: number }
    }

/**
 * `?project=<id>` when this sign-in has chosen a project (spec 052 FR-013), so
 * the team half of a listing and of the namespace is that project's alone.
 * Nothing when none is chosen: the server then answers as it always has, which
 * keeps an older credential, and an older instance, working unchanged.
 */
function projectQuery(credential: Credential): string {
  return credential.project ? `?project=${encodeURIComponent(credential.project)}` : ''
}

export function listMaps(credential: Credential, signal?: AbortSignal): Promise<CloudMapList> {
  return request<CloudMapList>(`/api/maps${projectQuery(credential)}`, { credential, signal })
}

/** The account's custom rules: its own, and those of the teams it is in. */
export function listRules(
  credential: Credential
): Promise<{ rules: CustomRule[]; teamRules: CustomRule[] }> {
  return request<{ rules: CustomRule[]; teamRules: CustomRule[] }>('/api/rules', { credential })
}

/**
 * Every team map this account can reach, with envelopes, in one request. Cloud
 * added it so building the namespace is not one request per map against the
 * maps rate limit. An older self-hosted instance answers 404 (a `server`
 * CloudError with status 404); callers fall back to one getMap per map.
 */
export function getTeamEnvelopes(
  credential: Credential,
  signal?: AbortSignal
): Promise<{ maps: { id: string; created_at: string; map_data: string }[]; unreadable: string[] }> {
  return request(`/api/maps/team-envelopes${projectQuery(credential)}`, { credential, signal })
}

export function getMap(
  credential: Credential,
  id: string,
  signal?: AbortSignal
): Promise<CloudMap> {
  return request<CloudMap>(`/api/maps/${encodeURIComponent(id)}`, { credential, signal })
}

/**
 * The account's keypair. The private half comes back wrapped.
 *
 * Unwrapping it needs the vault key, which is derived here from a passphrase.
 * A member who has never opened the web app has no keypair at all, and
 * `initialized: false` is the ordinary answer rather than an error.
 */
export function getUserKeys(credential: Credential): Promise<UserKeys> {
  return request<UserKeys>('/api/auth/keys', { credential })
}

/**
 * This account's wraps of a team key, newest version first once sorted.
 *
 * The server returns only the caller's own wraps — it cannot return anyone
 * else's, and holds nothing that would let it open these. `granted: false` is
 * the normal state for a member waiting on a teammate to grant them the key,
 * not a failure.
 */
export function getTeamKeyWraps(
  credential: Credential,
  teamId: string
): Promise<{ wraps: TeamKeyWrap[]; granted: boolean }> {
  return request<{ wraps: TeamKeyWrap[]; granted: boolean }>(
    `/api/teams/${encodeURIComponent(teamId)}/key`,
    { credential }
  )
}

export function createMap(
  credential: Credential,
  body: {
    name: string
    map_data: string
    identifier_count?: number
    scope?: 'personal' | 'team'
    description?: string
    /**
     * The team-key version `map_data` was sealed under. Team scope only.
     *
     * Required once a member has left the team holding a key: the server
     * refuses a write that declares a compromised version, or one the writer
     * does not actually hold (409 `rotationRequired`). Omitting it on a team
     * map is accepted only while no departure has ever made a rotation owed,
     * so it is always sent rather than sent conditionally.
     */
    key_version?: number
  }
): Promise<{ id: string }> {
  // A team map lands in the chosen project; a personal map has none (the
  // server ignores the field for it, and sending it would only blur that).
  const withProject =
    body.scope === 'team' && credential.project ? { ...body, project: credential.project } : body
  return request<{ id: string }>('/api/maps', { credential, method: 'POST', body: withProject })
}

/**
 * Replace a map's content in place: same id, name and project (spec 052 §2).
 *
 * `if_updated_at` is the version this client read. The server refuses with 409
 * when the map has moved on since, so two writers can never silently overwrite
 * each other - the refusal carries `current_updated_at`. A team map needs its
 * publisher (403) and a team that owes no key rotation (423).
 */
export function updateMapContent(
  credential: Credential,
  id: string,
  body: {
    map_data: string
    identifier_count: number
    if_updated_at: string
    /** Team maps: the key version `map_data` is sealed under, as on create. */
    key_version?: number
  }
): Promise<{ id: string; updated_at: string }> {
  return request(`/api/maps/${encodeURIComponent(id)}`, { credential, method: 'PATCH', body })
}

/**
 * The personal-maps key, wrapped under the vault key (spec 052 §1). Opaque to
 * the server, exactly as the wrapped private key is. `null` until the first
 * `vault unlock` (or browser unlock) creates one.
 */
export function getPersonalMapsKeyWrap(
  credential: Credential
): Promise<{ wrapped: string | null }> {
  return request('/api/auth/keys/personal-maps', { credential })
}

/** Store it - once. A second PUT is refused (409) by design: a silent
 *  replacement is how every map sealed under the first would become
 *  unreadable (research §7). */
export function putPersonalMapsKeyWrap(credential: Credential, wrapped: string): Promise<unknown> {
  return request('/api/auth/keys/personal-maps', { credential, method: 'PUT', body: { wrapped } })
}

/** One project the acting team works in, as `GET /api/projects` lists it. */
export interface CloudProject {
  id: string
  name: string
  /** The team's own maps in it - never another team's. */
  maps?: number
}

export function listProjects(credential: Credential): Promise<{
  projects: CloudProject[]
  teamId: string | null
  defaultProjectId?: string | null
}> {
  return request('/api/projects', { credential })
}

/** Whether the team owes a key rotation. Only `rotationNeededSince` is read
 *  from the answer; the rest names teammates and has no business here. */
export function getTeamKeyPending(
  credential: Credential,
  teamId: string
): Promise<{ rotationNeededSince?: string | null; nextVersion?: number }> {
  return request(`/api/teams/${encodeURIComponent(teamId)}/key/pending`, { credential })
}

/** Who this session belongs to: the account id a key grant names. */
export function getMe(credential: Credential): Promise<{ user?: { id?: string; email?: string } }> {
  return request('/api/auth/me', { credential })
}

/** Post a team-key wrap. Used here only to grant the team's first key to
 *  oneself; whether it is allowed is the server's decision. */
export function grantTeamKey(
  credential: Credential,
  teamId: string,
  body: { userId: string; version: number; wrappedKey: string }
): Promise<unknown> {
  return request(`/api/teams/${encodeURIComponent(teamId)}/key/grant`, {
    credential,
    method: 'POST',
    body,
  })
}

/** The account's team and its members - only how many is read here. */
export function getMyTeam(
  credential: Credential
): Promise<{ team: { id: string; members?: unknown[] } | null }> {
  return request('/api/teams/mine', { credential })
}

/** One base's reserved run of placeholder numbers, inclusive at both ends. */
export interface PlaceholderRange {
  base: string
  start: number
  end: number
}

/** A placeholder base, as the engine mints them: `__CLS__`, `__FN__`. */
const PLACEHOLDER_BASE = /^__[A-Z][A-Z0-9_]*__$/

/**
 * Take numbers out of the team's shared allocation, so two members anonymizing
 * at the same moment are never handed the same one.
 *
 * Counts and bases only. Never an identifier: the server cannot read a team's
 * maps and does not need to in order to count. `floor` is the highest number
 * this machine has already seen for that base - the server hands back
 * `max(counter, floor) + 1`, so a map numbered locally before the team existed
 * cannot be overwritten by a counter that never saw it.
 *
 * The base is checked here rather than only server-side. A malformed base would
 * otherwise create a counter row under a name no placeholder can ever match,
 * and the numbers reserved against it would be silently unusable.
 */
export async function reservePlaceholders(
  credential: Credential,
  teamId: string,
  requests: readonly { base: string; count: number; floor: number }[],
  signal?: AbortSignal
): Promise<{ ranges: PlaceholderRange[] }> {
  for (const { base, count } of requests) {
    if (!PLACEHOLDER_BASE.test(base)) {
      throw new CloudError(
        'forbidden',
        `${base} is not a placeholder base, so no numbers can be reserved for it`
      )
    }
    if (!Number.isInteger(count) || count < 1) {
      throw new CloudError('forbidden', `cannot reserve ${count} numbers for ${base}`)
    }
  }
  return request<{ ranges: PlaceholderRange[] }>(
    `/api/teams/${encodeURIComponent(teamId)}/placeholders/reserve`,
    { credential, method: 'POST', body: { requests }, signal }
  )
}

/**
 * Delete a map in Cloud.
 *
 * Who may delete a team map is the server's decision and is not restated here:
 * a 403 means it belongs to someone else on the team, a 404 that there is no
 * such map to this account. Both leave everything local untouched.
 */
export function deleteMap(credential: Credential, id: string): Promise<void> {
  return request<void>(`/api/maps/${encodeURIComponent(id)}`, { credential, method: 'DELETE' })
}

/**
 * The vault parameters, so the key can be derived HERE.
 *
 * The salt and the KDF cost are all the server holds, and all it can hold: the
 * passphrase never leaves this machine and the key is never transmitted. That is
 * the zero-knowledge claim, and it is kept by there being no code anywhere that
 * could send either.
 */
export function getVault(credential: Credential): Promise<VaultInfo> {
  return request<VaultInfo>('/api/auth/vault', { credential })
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

/** A failure response's body, or an empty object when it had none we can read. */
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json()
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// ─── Device authorisation: signing in by asking a browser ────────────────────
//
// `POST /api/auth/login` requires a CAPTCHA token this process cannot produce,
// and an account bound by a team's SSO requirement has no password path at all.
// Rather than ask a terminal to be a browser, it asks one.

export interface DeviceStart {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export function startDeviceLogin(instance: string, client: string): Promise<DeviceStart> {
  return request<DeviceStart>('/api/auth/device/code', {
    instance,
    method: 'POST',
    body: { client },
  })
}

/**
 * Exchange the long code for a session.
 *
 * Refusals arrive as RFC 8628 codes in `CloudError.message`:
 * `authorization_pending` while nobody has approved, `slow_down` when polling
 * faster than told, `expired_token` when the ten minutes are up or the code has
 * already been spent, `access_denied` when it was declined - or when the
 * browser session that approved has since been revoked, which is the same
 * answer on purpose.
 */
export function exchangeDeviceCode(
  instance: string,
  deviceCode: string
): Promise<{ token: string }> {
  return request<{ token: string }>('/api/auth/device/token', {
    instance,
    method: 'POST',
    body: { device_code: deviceCode },
  })
}
