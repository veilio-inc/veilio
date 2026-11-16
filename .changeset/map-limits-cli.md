---
'@veilio-inc/cli': patch
---

A push now checks the map before anything is sent and names the entry that is over a limit, so a pushed map can always be pulled. `veilio vault unlock` reads your personal maps in one request and, when Cloud limits requests, stops with one message. A map file holding a key that is not a placeholder is refused.
