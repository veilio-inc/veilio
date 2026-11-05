---
'@veilio-inc/cli': patch
---

`veilio scrub --team` reserves placeholder numbers once per call, for all its files together, instead of once per file. A team's first scrub of a large project no longer meets Cloud's rate limit. A name several files share still gets one placeholder.
