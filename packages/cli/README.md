# @veilio-inc/cli

Anonymize code before it reaches an LLM, restore it after — from a terminal, a pipe, or a pre-commit hook.

```bash
veilio scrub src/billing.ts | pbcopy     # mask, then paste anywhere
pbpaste | veilio restore                 # bring the answer back
git diff --cached | veilio scan          # refuse to commit a live key
```

## Commands

| Command | Purpose |
|---|---|
| `scrub [files...]` | Mask identifiers, redact credentials. Reads stdin when given no file. |
| `restore [files...]` | Swap placeholders back, strip AI-generated noise. |
| `scan [files...]` | Detect credentials only. Never rewrites. Exits 1 on findings. |
| `map` | Show the symbol map (`--clear` to wipe it). |

## Options

```
-l, --language <lang>   auto (default), typescript, python, go, java, csharp,
                        rust, ruby, php, c, sql
-s, --secrets <policy>  redact (default) | warn | off
-p, --preamble          Prepend the downstream-AI note and placeholder legend
-m, --map <path>        Use a specific map file
    --json              Machine-readable output (scan, map)
    --strict            scan: also fail on advisory findings
-q, --quiet             Suppress the stderr summary
```

## Piping

Transformed code goes to **stdout**; summaries, warnings and errors go to **stderr**. That split is what makes the CLI composable — the summary stays visible without corrupting the pipe.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Clean |
| 1 | Findings that should stop the pipeline |
| 2 | Usage or IO error |

As a pre-commit hook:

```bash
#!/bin/sh
git diff --cached | veilio scan || {
  echo "Commit blocked: credentials detected." >&2
  exit 1
}
```

## The symbol map

`scrub` writes `.veilio/map.json` at the project root and `restore` reads it, so placeholders stay stable across runs and across a whole session. The store is created `0600` with its own `.gitignore` — it holds the real identifier names, so committing it would undo the anonymization for anyone reading the repo.

Redacted credentials are **not** in the map. `restore` cannot bring them back, by construction.

## In CI

### GitHub Action

```yaml
- uses: veilio-inc/veilio/packages/cli@v0.1.0
  with:
    strict: false          # also fail on emails / private IPs
    sarif: veilio.sarif    # optional: upload to code scanning
```

Scans the **pull-request diff** by default, not the whole tree. A repo adopting
this mid-life almost always has a historical finding somewhere; blocking every PR
on that is how a security check gets switched off in week one. Pass `paths:` to
scan a fixed set instead.

Findings land in the job summary and, with `sarif:`, in GitHub code scanning.
Reports carry truncated previews only — a stored, shareable artifact must never
contain the credential it is reporting.

### Pre-commit

Via the [pre-commit framework](https://pre-commit.com):

```yaml
repos:
  - repo: https://github.com/veilio-inc/veilio
    rev: v0.1.0
    hooks:
      - id: veilio-scan
```

Or a plain git hook:

```bash
cp packages/cli/hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

It scans the **staged** diff — what you are about to commit is what matters, and
a finding in an unstaged scratch file shouldn't block you. `--no-verify`
overrides, as usual.
