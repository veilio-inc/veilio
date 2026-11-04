---
'@veilio-inc/engine': patch
---

`restore` keeps the writer's blank lines. Python's two blank lines between top-level definitions (PEP 8) are no longer squashed to one. A line that held only a stripped comment is removed whole, instead of being left empty. Three or more blank lines still become two.
