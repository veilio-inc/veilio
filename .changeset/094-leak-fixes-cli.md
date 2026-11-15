---
'@veilio-inc/cli': patch
---

Shell scripts, Dockerfiles, YAML, `.env`, INI and text files are masked without reading `//` or `/*` as comments. The values of a Kubernetes Secret are redacted, in a YAML file and on stdin. These take effect with engine 1.19.2.
