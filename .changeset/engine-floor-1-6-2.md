---
'@veilio-inc/cli': patch
'@veilio-inc/mcp': patch
---

Require `@veilio-inc/engine` 1.6.2. It carries two fixes both tools rely on: a whitelist rule now applies to names a map already holds, and restore no longer replaces a placeholder inside a longer number. With the old `^1.6.0` floor an install could resolve 1.6.1 and silently miss both.
