---
'@veilio-inc/cli': minor
---

Sign in to Veilio Cloud and sync personal maps from the terminal.

`veilio login` prompts for credentials and writes a session token to a single
file under your home directory; `veilio whoami` reads it without making a
request, and `veilio logout` revokes server-side before removing it. `veilio
maps list`, `maps pull <id>` and `maps push <name>` move maps between the local
store and Cloud.

Map sync is zero-knowledge. The vault key is derived locally from your
passphrase with PBKDF2-SHA256 and the server holds only a per-account salt, so
Cloud stores ciphertext it cannot read. `maps pull` decrypts locally and writes
second, so an interrupted pull never leaves a partial map.

`scrub`, `restore`, `scan` and `map` are unchanged and still make no network
call. Signing in adds nothing to them; it only unlocks the commands that name
Cloud explicitly.
