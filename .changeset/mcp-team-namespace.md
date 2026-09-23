---
'@veilio-inc/mcp': minor
---

Resolve identifiers against the team's shared namespace, and say which one was
used.

Every anonymize result now states the namespace that produced its placeholders:
`team` when resolved against the team's shared dictionary, fetched from Cloud
once at startup, so every teammate's agent produces the same placeholder for the
same identifier; `local` when resolved locally.

`local` is the normal, fully-functional state for anyone not on a paid team. The
server never blocks on the fetch, and the fallback is always stated rather than
silent — a shared placeholder that quietly stopped being shared would be worse
than one that was never shared at all.

There is no separate sign-in here. The server reads the same credential file
`veilio login` writes.

Team namespace resolution is not zero-knowledge: merging identifiers across
teammates requires the server to hold them in plaintext. Personal map sync in the
CLI is a different mechanism and remains zero-knowledge.
