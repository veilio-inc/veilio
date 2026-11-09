---
'@veilio-inc/cli': minor
'@veilio-inc/mcp': minor
---

Team maps are written only under a team key whose granter this device confirmed. `veilio team unlock` judges each key: one you made, or one from a teammate you confirmed, is used to save maps; one from a teammate not yet confirmed is kept read-only and its fingerprint is printed; a confirmed teammate's changed key, or a key labelled as yours that is not, is not stored. New: `veilio team trust <team> <fingerprint>` records the confirmation (in `~/.veilio/key-pins.json`, never sent to Veilio), and `veilio keys fingerprint` shows your own. `maps push --team`, `maps update` and the MCP server's `maps_create` and `maps_update` refuse while the newest team key is not confirmed. After upgrading, run `veilio team unlock` once; a teammate's grant needs one `veilio team trust` per device.
