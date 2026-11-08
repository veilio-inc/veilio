---
'@veilio-inc/mcp': patch
---

`restore_text`, `symbol_map_summary` and the `anonymize_*` tools refuse a map that git tracks, one reached through a link, or one another user owns (through the CLI's store), and `maps_remove` no longer names the map when `confirmName` does not match.
