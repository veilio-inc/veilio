---
'@veilio-inc/mcp': patch
---

A link or junction inside the project root that leads outside it is refused.

`anonymize_file` and `scan_secrets` compared paths as text, so `link-outside/secret.txt` under the root read a file outside it when `link-outside` was a symlink or a Windows directory junction, which needs no admin rights. The server now also checks where a path really leads, and reads that resolved path. Links that stay inside the root, and a root that is itself reached through a link, still work. Reported from a Windows test session; the same applies to a symlink committed to a repository on any platform.
