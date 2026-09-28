---
'@veilio-inc/cli': patch
'@veilio-inc/mcp': patch
---

Correct two README claims that stopped being true at 0.3.0.

The MCP server's README listed the reasons a result reports the `local`
namespace — not signed in, offline, or a plan without shared dictionaries — and
left out the one that now matters most. The team namespace is merged on the
client, so on a Team plan it resolves to `team` only once `veilio team unlock`
has opened the team key on that machine. A reader of the old text would see a
working tool and never reach the feature they are paying for.

The CLI's README explained its GitHub Action example by saying the CLI is not on
npm and the only tags in the repository are `engine-v*`. Both are now false; what
the example still needs is a `v*.*.*` tag, which is also what triggers the
Community Edition release workflow.
