---
'@veilio-inc/cli': patch
---

`veilio scrub --team` reserves placeholder numbers once per call, for all its files together, instead of once per file (more than once only when the files need more new names than one reservation may ask: 5000 per kind, 32 kinds). A team's first scrub of a large project no longer meets Cloud's rate limit. A name several files share still gets one placeholder. A single file that needs more than one reservation allows is refused with that reason.
