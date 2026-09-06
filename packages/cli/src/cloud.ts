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

/** The public Cloud. `--instance` overrides it for a self-hosted deployment. */
export const DEFAULT_INSTANCE = 'https://app.veilio.dev'

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
  | 'unauthenticated'
  | 'unentitled'
  | 'suspended'
  | 'forbidden'
  | 'unreachable'
  | 'server'

export class CloudError extends Error {
  constructor(
    readonly kind: CloudErrorKind,
    message: string,
    readonly status?: number
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
  method?: 'GET' | 'POST' | 'DELETE'
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
    'X-Veilio-Client': 'cli',
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
    throw new CloudError('forbidden', message ?? 'not permitted on this account', 403)
  }

  if (!response.ok) {
    const body = await bodyOf(response)
    throw new CloudError(
      'server',
      typeof body.error === 'string' && body.error !== ''
        ? body.error
        : `${base} returned ${response.status}`,
      response.status
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
  updated_at: string
  /** `client-envelope` means WE decrypt it; anything else the server already did. */
  storage: string
}

export interface CloudMapList {
  personalMaps: CloudMapSummary[]
  teamMaps: CloudMapSummary[]
  /** Placeholder -> identifier, merged across the team's maps. Null when the
   *  account has no active team or the plan lacks shared dictionaries — the
   *  server's entitlement answer, not a client-side guess (spec 005 US4). */
  teamNamespace: Record<string, string> | null
  plan: string
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

export function listMaps(credential: Credential): Promise<CloudMapList> {
  return request<CloudMapList>('/api/maps', { credential })
}

export function getMap(credential: Credential, id: string): Promise<CloudMap> {
  return request<CloudMap>(`/api/maps/${encodeURIComponent(id)}`, { credential })
}

export function createMap(
  credential: Credential,
  body: { name: string; map_data: string; identifier_count?: number; scope?: 'personal' }
): Promise<{ id: string }> {
  return request<{ id: string }>('/api/maps', { credential, method: 'POST', body })
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
