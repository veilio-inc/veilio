---
'@veilio-inc/cli': patch
---

`veilio team unlock` now sets up the team's first key when the team has none, as the web app does. A team of one starts with no key, and had no teammate to grant one, so a solo developer could never publish a team map from the terminal. The key is minted here and wrapped to the account's own public key, in the web app's format. The server decides whether this is the team's first key; if it refuses, because another member got there first, `team unlock` stands down and never makes a second key. A team of one is no longer told to ask a teammate. An account with no keypair yet is told to unlock its vault once in the web app. The CLI never takes the account's own public key on the server's word: it computes it from the private key it has just unwrapped, and refuses if the server's copy differs. After setting up the key it reads it back and checks it byte for byte.
