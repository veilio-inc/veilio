---
'@veilio-inc/cli': patch
---

`veilio maps pull` opens a team map. It used the vault key for every map and failed on a team map with "Unrecognized vault envelope"; a team map now opens with the team key `veilio team unlock` stored, without asking for the vault passphrase. With no team key unlocked it says to run `veilio team unlock`, and it writes nothing it could not open.
