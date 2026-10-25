// Signing in or out while the server runs changes its tool list (spec 052
// FR-023): the map, team and project tools exist only for a signed-in person.
// The server declares `listChanged: true` and, when the credential file
// appears or disappears, sends `notifications/tools/list_changed`. Without it,
// a client that read the list once at start would never offer the map tools
// after `veilio login`, and would go on offering them after `veilio logout`.
//
// Polled rather than `fs.watch`-ed. The file is replaced and removed whole, a
// watch on a file that does not exist yet needs a watch on its directory, and
// both behave differently across platforms. A local read every two seconds is
// cheap and the same everywhere.

import { readCredential } from '@veilio-inc/cli/credential'

/** The notification MCP defines for a changed tool list. No id: not a request. */
export const TOOLS_LIST_CHANGED = {
  jsonrpc: '2.0',
  method: 'notifications/tools/list_changed',
} as const

export const SIGN_IN_POLL_MS = 2000

export class SignInWatcher {
  private signedIn: boolean

  constructor(
    private readonly home: string | undefined,
    private readonly notify: () => void
  ) {
    this.signedIn = readCredential(home) !== null
  }

  /** Whether the sign-in changed since the last check; notifies once if so. */
  check(): boolean {
    const now = readCredential(this.home) !== null
    if (now === this.signedIn) return false
    this.signedIn = now
    this.notify()
    return true
  }
}
