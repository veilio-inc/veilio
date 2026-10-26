// This process is the MCP server, and every request it makes says so
// (tracker d12): `X-Veilio-Client: mcp` and `User-Agent: veilio-mcp/<version>`.
// Its requests go through the CLI's client, which would otherwise label them
// `cli`, so a burst from an agent read as a burst from a terminal.
//
// Set when this module loads, which happens before any tool or namespace
// request: tools.ts imports it first. A self-report for the server's logs,
// never an access decision.

import { createRequire } from 'node:module'
import { setClientIdentity } from '@veilio-inc/cli/client'

const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string })
  .version

setClientIdentity({ client: 'mcp', userAgent: `veilio-mcp/${VERSION}` })
