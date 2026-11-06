---
'@veilio-inc/cli': patch
'@veilio-inc/mcp': patch
---

`restore` strips a JSDoc block only where its `/**` opens in code. A `/**` inside a string, a template literal, a regex literal or another comment is left alone: `"src/**/*.ts"` no longer loses the rest of its line, `"a/**/b"` no longer takes every line up to the next `*/` with it, and a `/** */` inside a `//` comment stays in that comment (inside a `// TODO` it is stripped once, with the TODO). An empty `/**/` is a plain block comment. JSDoc inside a fenced markdown code block is still stripped.
