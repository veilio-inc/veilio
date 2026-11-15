# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for
anything exploitable.

- Preferred: GitHub **Private vulnerability reporting** (this repo → **Security**
  tab → *Report a vulnerability*).
- Or email: `security@veilio.dev` 

We aim to acknowledge within 72 hours and to ship fixes for confirmed issues in
the anonymization engine promptly, since it is the privacy-critical core.

## Scope and known limitations

### `@veilio-inc/engine` privacy invariants
The engine is a pure, local transform: **no network, no telemetry, no
environment reads, zero runtime dependencies.** These are enforced in CI
(`packages/engine/tests/purity.test.ts`). A change that violates them should be
treated as a security regression.

### Custom-rule patterns
Custom rule patterns run on a linear-time matcher, not on the platform's regular expressions, so a pattern cannot make matching take more than time proportional to the text.

### Imported symbol maps are authenticated, not trusted
A `.veilio` file is encrypted with AES-256-GCM, so decrypting one proves the
author knew the passphrase. Sharing maps with colleagues is the point of the
format, so that proves the author was someone you gave the passphrase to — **not
that the contents are what you expect.** Everything in a map is substituted into
restored source, which you then read and often paste into an editor.

On import the app validates the decrypted map before it reaches a restore
(`src/lib/importedMap.ts`): keys must be placeholder-shaped, values must be
strings, and both the entry count and value length are bounded. This makes a
malformed or hostile file fail loudly at the boundary instead of quietly
deforming a restore, and it is what refuses prototype-pollution keys such as
`__proto__`.

It does **not** make an imported map safe. A well-formed map from someone else
can still map `__FN__1` to text you did not write. Import maps only from people
you would accept a patch from, and read restored output before running it.

### Saved maps are sealed, not bound to their id
A map saved to Veilio Cloud is encrypted with a key that only you, or your team, hold, so the server can neither read one nor alter one undetected. The encryption does not bind a map to its id, though: a server that misbehaved could hand you one of your own maps in place of another one of yours. You would see the wrong names restored, never another account's.

Saved maps are not tied to a version: anyone who can write your map files can put back an older copy, and Veilio restores from it as written. Binding maps to a version is planned for the next release.

### Known limitation — names with letters outside A–Z
Names that contain letters outside A–Z are not yet masked whole. A name written only in Greek or Cyrillic letters (for example `παραγγελία`) is not masked at all. A name that mixes A–Z with other letters (for example `wyślijPaczkę` or `größeBerechnen`) is masked only in its A–Z parts, so the other letters reach the model. Names written only in A–Z are not affected. Until this is fixed, rename such names, or leave files that use them out of what you send. Full support is planned for the next release (#224).

### Known limitation: programs the agent runs act as you
A program the agent starts runs as your user, so it can read and change any file you can, including `~/.veilio`, the project's `.veilio/guard.json` and Claude Code's own settings. The raw-only list (refused when a command names a file or one of these folders, by any spelling bash or zsh turns back into the name; this stops ordinary and accidental reads, not a command written to get past it) raises the cost of reading them and does not stop a determined agent. The off switch is held in memory for one session and is not a file, so there is no off record for a program to write; a program that edits Claude Code's settings can still disable the plugin. The strong controls are the output filter, which removes credentials from everything the model sees, and managed installs, which force the guard on.

### Export passphrases have a floor, not a strength guarantee
A `.veilio` file is the one artifact designed to leave the machine, so once it
has, its passphrase is attacked offline at whatever rate the attacker's hardware
allows. New exports are derived with PBKDF2-HMAC-SHA256 at 600,000 iterations
(recorded per-file, so the cost can be raised without orphaning old files), and
exports require a passphrase of at least 12 characters that is not a trivially
guessable pattern.

That is a floor. It rejects choices that are bad by construction; it cannot tell
that an otherwise-valid passphrase is a poor one, and the app deliberately shows
no strength score rather than implying approval it cannot give.

The floor is **not** applied on import: a file written by an older build may be
protected by a passphrase that would now be rejected, and refusing to open it
would be data loss.

### Anonymization is best-effort
The engine reduces, but cannot guarantee elimination of, identifying information
(e.g. identifiers embedded in unusual string formats). Always review anonymized
output before sharing it.

Known limits of the comment and credential rules:

- Text between tags in JSX is read as code, not as text: a `/*` there followed
  later in the file by `*/` is read as a comment, and names between the two go
  out as written.
- A `/*` whose `*/` stands inside a later string (`"s */"`) is closed there, so
  the text between the `/*` and that string stays readable as a comment. In a
  Python triple-quoted text an escaped `\"""` is not read as an escape.
- A provider key written as adjacent string literals on one statement is found
  and redacted. A key assembled from variables, across statements, with escape
  sequences or with invisible characters between its parts is not: no text
  transform can follow that. Nor is one joined in another way: Python
  `"..." f"..."`, PHP `.`, `+=`, `[...].join("")`, a comment or a bracket after
  the `+`, a template `${""}`, Rust `concat!`.
- A private key is redacted from its BEGIN line on, also when the END line is
  missing. In a Kubernetes manifest of `kind: Secret`, every value under `data`
  and `stringData` is redacted. A Secret produced by a template (Helm) is not
  recognised.
- A private key is not read as one when it stands in a single string with `\n`
  escapes and no END line, is split over several string literals or the quoted
  lines of a YAML list, goes on after a line that is not key text (a `# note`),
  is written in base64url letters (`-`, `_`), or has a header that is not PEM's
  (`----- BEGIN PRIVATE KEY -----`).
- A Kubernetes Secret is read in a YAML or JSON document. Text given with no
  file name, kind or language (pasted text, a pipe, inline text) is read only
  when `kind:` and `data:` or `stringData:` start their lines, so a Secret
  inside a `List` is not read there. Not read anywhere: a manifest built as
  an object in code or held in a string of a file whose language is known, a
  value brought in by a YAML alias or
  merge key (`<<: *base`; the alias is redacted, the anchored value is not), a
  sequence under `data` at the key's own indent, and a part of a `.json`
  manifest read without the rest of it. Those values are masked like names and
  are held in the map.
- In a URL, a credential is not found when its parameter's name is
  percent-encoded or bracketed (`%3Ftoken=`, `?data[token]=`) or follows a `;`
  (`;jsessionid=`).
