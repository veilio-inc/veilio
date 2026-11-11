---
'@veilio-inc/mcp': patch
---

Opening a vault with the passphrase refuses a key-derivation cost from Cloud below 600,000 or above 4,000,000 iterations, instead of running whatever number the server reports.
