---
'@veilio-inc/cli': patch
'@veilio-inc/mcp': patch
---

`restore` keeps the writer's text as written and removes only the noise it strips. Python's two blank lines between top-level definitions (PEP 8) are no longer squashed to one, and blank lines and whitespace-only lines are no longer rewritten file-wide.

Each stripped item is removed where it sits:

- a line that held only stripped items goes, and where removed lines sat among blank lines, the longest stretch of blank lines is kept, counted once;
- an item at the start of a line takes the space after it and keeps the line's indent (for code after a multi-line JSDoc, the indent the JSDoc began at), and one at the end takes the spaces before it;
- an item inside a line leaves the spacing around it.

Stripped items report the AI response's own line numbers. A JSDoc and a `//` comment on the same line are both stripped. CRLF text is handled the same way as LF. Restore stays linear on long runs of spaces and on many stripped items.
