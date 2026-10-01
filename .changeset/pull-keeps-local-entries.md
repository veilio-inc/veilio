---
'@veilio-inc/cli': patch
---

`veilio maps pull` no longer drops placeholders the project's map has.

A staging walk found a project that had scrubbed new names after its pull, and then lost them on the next pull of an unchanged Cloud copy. Text already masked with those placeholders could no longer be restored. The old check refused only when the Cloud copy had changed too.

Now a pull stops, writes nothing and names the placeholders whenever the project's map has one that the pulled map lacks or names differently. This applies whether or not Cloud changed, and also to a project map that was never pulled. Push the local map first, or pass `--force` to replace it.
