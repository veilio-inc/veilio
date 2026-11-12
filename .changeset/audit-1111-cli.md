---
'@veilio-inc/cli': patch
---

The GitHub Action runs the CLI version it was released with instead of `latest`; set the `version` input to `latest` to track the newest. The vault passphrase step refuses a key-derivation cost from Cloud below 600,000 or above 4,000,000 iterations, instead of running whatever number the server reports.
