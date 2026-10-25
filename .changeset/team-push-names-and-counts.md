---
'@veilio-inc/cli': patch
---

`veilio maps push --team` now names the map it published beside its id, and reports the team's shared set as an exact union ("now holds 2 identifiers"), not an "about" sum that counted a name twice when this map and the team both held it. `veilio maps rm` confirms which map went by its name and id, falling back to the id alone only when the name cannot be read; a failed read never stops the removal.
