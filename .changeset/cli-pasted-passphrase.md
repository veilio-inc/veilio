---
'@veilio-inc/cli': patch
---

A pasted passphrase now works at every hidden prompt (`team unlock`, `maps pull`, `maps push`, `login`). Terminals wrap pasted text in bracketed-paste markers, and the prompt kept them as part of the passphrase, so a correct passphrase was reported as wrong. Escape sequences such as arrow keys no longer add invisible characters either.
