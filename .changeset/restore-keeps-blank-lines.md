---
'@veilio-inc/engine': patch
---

`restore` keeps the writer's blank lines. Python's two blank lines between top-level definitions (PEP 8) are no longer squashed to one. Each stripped item is now removed where it sits:
- an item that fills its line takes the line with it, and between two blank lines it also takes one of them;
- an item at the end of a line takes the spaces before it, so no trailing whitespace is left;
- an item inside a line leaves the spacing around it.

Stripped items report their own line, not the first occurrence's. A JSDoc and a `//` comment on the same line are now both stripped.
