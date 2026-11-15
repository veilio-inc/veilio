---
'@veilio-inc/mcp': patch
---

The restore and destructive switches are ignored when a project file names them in any JSON spelling or cannot be parsed. Shell scripts, Dockerfiles, YAML, `.env`, INI and text files are masked without reading `//` or `/*` as comments, and the values of a Kubernetes Secret are redacted, with engine 1.19.2.
