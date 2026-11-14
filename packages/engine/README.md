# @veilio-inc/engine

Two-way code anonymizer for AI. Replace real identifiers in source code with role-typed
placeholder tokens (`__CLS__1`, `__FN__2`, …) **before** sending it to an LLM,
then restore them in the reply.

> **Veilio is a set: install the guard, the CLI and the MCP server together.** Each does one job, and all three share one map (`.veilio/map.json`).
>
> - **[veilio-guard](../../plugins/veilio-guard/README.md)** keeps your names from the model while a coding agent works: it masks everything the agent reads - files, command output, search results and your prompts. Claude Code today; other agents are in progress.
> - **[The CLI](../cli/README.md) (`@veilio-inc/cli`)** does what the guard cannot, because the guard makes no network call: `veilio scrub` builds the map before the first session, `veilio maps pull` brings in your team's map and its numbers, `veilio rules pull` your custom rules, `veilio restore` brings back the names in an answer, and `veilio scan` stops a live key in a commit or in CI.
> - **[The MCP server](../mcp/README.md) (`@veilio-inc/mcp`)** gives the agent tools of its own: read a file masked, restore an answer (opt-in), scan for secrets. In an agent the guard does not cover yet, it is the way in - with the agent's own file and shell tools turned off.
>
> **Without the guard, the CLI and the MCP server protect only what passes through them.** An agent that reads files and test output with its own tools sends them to the model as written: in our benchmark (spec 067, run 3), project names reached the model in 93-95 of 96 sessions with the MCP server or the CLI alone, and in 0 of 96 with the guard.

```ts
import { anonymize, restore } from '@veilio-inc/engine'

const { anonymized, map } = anonymize('class PaymentService { chargeOrder(orderId) {} }')
// anonymized → "class __CLS__1 { __FN__1(__VAR__1) {} }"
// ...send `anonymized` to an AI, get a reply that still contains the tokens...
const { restored } = restore(aiReply, map)
```

## If you would rather not write code

Two ready-made surfaces wrap this package, in the same repository. Both run the
engine in your own process, and neither opens a network connection.

|                                       |                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@veilio-inc/cli`](../cli/README.md) | `veilio scrub \| pbcopy`, `restore`, and a `scan` that exits non-zero on a live credential — for pipes, pre-commit hooks and CI.                           |
| [`@veilio-inc/mcp`](../mcp/README.md) | An MCP server for coding agents. Its tools take a **file path**, so the server reads the file and the agent sees `__CLS__1.__FN__2()`, not the real names. |

They share one symbol map, so you can mask inside an agent and restore from a
terminal, or the reverse.

```bash
npm install -g @veilio-inc/cli    # the `veilio` command
npx -y @veilio-inc/mcp --root .   # the MCP server, as an agent launches it
```

## What it hides, and what it does not

Masked:

- every identifier the language does not define — classes, functions,
  variables, properties, and the words of import paths — as `__CLS__n`,
  `__FN__n`, `__VAR__n`, `__PKG__n`, unless it is a single ordinary word
  (below);
- every word of a value — inside a string literal (URL paths, error
  messages, the table and column names in SQL), after `=` or `:` in a
  dotenv, INI, properties, TOML or YAML file, in XML attribute values and
  element text, in a shell command's `KEY=val` — as `__STR__n` and the like,
  ordinary words included; only a path-shaped string (`'./src/utils'`) keeps
  them readable;
- bank account, card and PESEL numbers (reversibly), and credentials
  (irreversibly — see below).

Not masked:

- **single ordinary words** — a name that is one common English word, a word
  every codebase shares, or a toolchain's name, written lower-case, Capitalised
  or in capitals: `refund`, `Ledger`, `TOTAL`, `billing`, `src`, `vitest`. They
  are nobody's secret, and they let a model find its way around the code. A name
  with an inner capital, an underscore or a digit (`refundInvoice`,
  `customer_invoices`, `invoice2`) is a choice somebody made and is masked, as
  are invented and rare words (`tarnwick`, `quayward`). A custom rule can still
  mask any word. This holds for names and path segments only, never for a
  value (above). A value whose key names a credential — the key contains
  `pass`, `pwd`, `secret`, `token`, `key`, `auth`, `cred`, `private`, `salt`,
  `jwt`, `bearer` or `mnemonic`, or a camel, snake or kebab segment of it
  starts or ends with `pw`, `otp`, `pin`, `seed` or `cert` (`password:
  sunshine`, `const DB_PASS = "Summer2024!"`, `dbPw`, `DBPW`, `--db-password=`,
  `_authToken=`, `Password=sunshine;` inside a connection string) — is a
  secret: it is redacted one-way, whole, in every `secrets` mode, so the map
  never holds it. Outside code a credential net reads every line: the
  credential-named name, any separator (whitespace, `=`, `:=`, `:`, `->`,
  `=>`, quotes, a `\` continuation, `<![CDATA[`, a tag's `>`, and `(`, `[` or
  `,` before a quoted value), and the value - `password sunshine` in a
  properties file, `.netrc`'s `password sunshine`, a Makefile's `PASSWORD :=
  sunshine`. A quoted value ends at its closing quote, element text at `<`,
  CDATA at `]]>`. A `.pgpass` line's fifth
  field is a password. Prose is over-masked on purpose: "password reset"
  redacts "reset". The net fails closed: only a value of one or two
  characters, an unquoted `$NAME` or `${NAME}`, a language keyword (`null`,
  `true`, `None`), text already masked, and - in code only, as the whole value
  - a call or member access (`os.getenv("KEY")`, `config.secret`) is left; a
  path, a URL, a number, a CI expression or a shell command under a
  credential word is redacted. An unquoted value runs to the next whitespace
  (`sun,shine` is one); a quote, brace or paren ends it only when it was
  opened before the key (a `"KEY=value"` string, an object, a call). Text
  pasted with no path whose language is only guessed is read by the
  net too, for a line's own `KEY=value` or `KEY := value`. In code a
  bare `key = word` may name a variable and keeps a reversible placeholder;
- **comments**, apart from names the map holds (below). The result's `comments`
  counts how much comment text goes out as written;
- **names written entirely in capitals** — constants, enum members, environment
  variable names: `ACME_TENANT_ID`, `process.env.ACME_API_KEY`. They stay
  readable so that SQL keywords and `MAX_RETRIES` stay code, which means a
  company or customer name inside one goes out as written;
- names of one or two characters, language keywords, and standard-library names;
- numbers, and the shape of the program: its control flow and the structure of
  its SQL and URLs.

So what holds is: no mixed- or lower-case internal identifier other than a
single ordinary word, no word of a value other than a path's ordinary
segments, and no credential reaches the model. Not "the model cannot tell what
this code does" — the shape and one comment will often say it is billing code.

## Ten languages, not one

The engine masks every identifier it does not recognise, so the keyword set is
load-bearing: a missing reserved word gets masked, and masking `func` or `def`
leaves output no model can read as source code. Keyword sets and comment syntax
are per-language, and the language is detected from the source:

```ts
anonymize(goSource).language // → 'go'
anonymize(source, { language: 'rust' }) // or force it
```

Supported: TypeScript/JavaScript, Python, Go, Java/Kotlin, C#, Rust, Ruby, PHP,
C/C++, SQL. Detection falls back to TypeScript when the source is ambiguous, and
says so: `languageFallback` is `true` when no marker matched, which means the
file was tokenised with rules that do not describe it and the masking is
partial. It rides on the result rather than in UI state, so the web app, the CLI
and the MCP server all see the same fact rather than each deciding whether to
mention it.

Comment text is prose and is left as written — turning it into ciphertext is
what makes a downstream model refuse to help — with one exception: a name the
map holds is replaced by its placeholder wherever it stands as a whole word in
a comment, so a comment cannot say what the placeholder beside it means. That
covers `#` comments, Python docstrings, SQL `--`, and Ruby `=begin` blocks, not
just `//`. A name the map does not hold yet, a person, a customer or a ticket
number in a comment goes out as typed; mark those by hand (below). Single
ordinary words and lowercase one-word string literals stay readable in
comments.

## Credential guard

Identifier masking protects a domain model. It does nothing about the leak that
actually costs money — a live key in the payload. Worse, a credential that
happens to be identifier-shaped would otherwise be masked _reversibly_, i.e.
stored in the symbol map.

So credentials are found before masking and replaced **irreversibly**:

```ts
const { anonymized, secrets } = anonymize(code)
// anonymized → 'const k = "__REDACTED_STRIPE_KEY_1__"'
// secrets    → [{ type: 'stripe-key', severity: 'critical', line: 1,
//                 preview: 'sk_l…MNOP (31 chars)', redacted: true }]
```

The replacement never enters the map, so `restore()` cannot bring it back. AWS,
Stripe, GitHub, Slack, OpenAI, Anthropic, Google and npm keys, JWTs, bearer
tokens, PEM private keys and connection-string passwords are redacted; emails
and private IPs are reported but left in place. Findings carry a truncated
preview, never the full value — they are rendered in UIs and may be logged.

Every finding also says what the scan did with the value, in `disposition`:
`'destroy'` (redacted, unrecoverable), `'mask'` (masked reversibly — see below),
or `'report'` (the scan left it in place). `redacted` remains the coarse boolean
a badge can read; `disposition` is the finer answer.

Policy is configurable: `{ secrets: 'redact' }` (default), `'warn'`, or `'off'`.
Under `'warn'` no rule's finding is redacted: findings come back with `disposition:
'report'` and each credential a rule finds is left in the text as written. A
value found by its credential-named key alone (above) is redacted one-way in
every mode all the same: it is never readable and never mapped. Under `'off'`
nothing is reported either. **In no mode does a credential go into the symbol
map**: identifier masking leaves every credential the rules find alone. A name
written exactly as a destroyed credential is replaced by that credential's
redaction token: every other occurrence of a destroyed credential is, in a
string, a URL, as a name, anywhere. A credential of 4 or more characters is
replaced wherever it stands, inside a longer name or a URL too; a shorter one
only as a whole word. Every occurrence of every credential is found on its
own, and occurrences that overlap or touch are replaced as one span: by the
covering credential's token, or by a new generic token where several meet, so
no character of any of them is left. The one exception is a well-known default
(`postgres`, `root`, `admin`, `mysql`, `sa`, `guest`, `test`, `user`,
`password`, `changeme`, `secret`, `demo`) or common weak password (`pass`,
`pwd`, `passw0rd`, `password1`, `1234` to `12345678`, `qwerty`, `letmein`,
`welcome`, `abc123`, `P@ssw0rd`), replaced only as a whole word, and
left as written where it stands in a position that
is not a secret: an image name, a URL scheme, a URL user, a URL host, a user
field, or a compose service name. Beside `POSTGRES_PASSWORD: postgres`, `image: postgres`
and a `postgres://` scheme stay, and are not mapped. Where the credential is left in the text by design (`warn`,
`off`, a fixture), the equal name is left too and is not mapped. A name that only
contains a credential, or is part of one, is masked and mapped like any other
name. An entry an existing map
holds for a credential is dropped, whether it is one on its own or one found in
the text, and its number is not reused. So nothing secret is written to
a saved map or uploaded with it. (Earlier versions masked an identifier-shaped
key reversibly, into the map, under `'warn'` and `'off'`.)

### Passwords in a secret position

Some slots can only hold a credential, so the value there is removed whatever
its strength. A weak password (`postgres`, `hunter22`) is exactly what a person
types into one:

- password flags: `-p<pw>` (attached only) after a mysql or mariadb client,
  where `-p <word>` is the database name; `-p <pw>` attached or not after a
  mongo client or sshpass; `-P <pw>` for sqlcmd, bcp, osql, isql and ipmitool;
  `redis-cli -a <pw>`; `--password`, `--passwd` and `--pass` with `=` or a
  space. Each of these is matched in an argv array too, the flag and its
  value as one element or two (mysql's `-p` only as one). The same rule holds
  in every file and with no path: the value after `--password` is a password
  unless it is a help-text metavar (`PASSWORD`, `PASS`, `PASSWD`, `PWD`,
  `TEXT`, `VALUE`, `SECRET`, `STRING`, `TOKEN`, `KEY`, `[…]`, `<…>`) or a
  common prose word (`to`, `for`, `is`, `in`, `and`, `or`, `on`, `with`,
  `when`, `if`, `as`, `of`, `the`, `a`, `an`, `that`, `this`, `from`). So `--password TEXT` in help text is left alone
  and `--password hunter2` in a README is redacted. Port flags (`mysql -P 3306`, `psql -p 5432`, `ssh -p 22`,
  `docker run -p`) and flags with no value (`--password-stdin`,
  `--password-file`, `--no-password`) are left alone. A command continued
  with a trailing backslash is one command;
- well-known password environment variables: `PGPASSWORD`, `MYSQL_PWD`,
  `POSTGRES_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `MSSQL_SA_PASSWORD`,
  `REDISCLI_AUTH`, `SSHPASS` and others, in shell, dotenv, compose and
  PowerShell forms (a bare YAML block header such as `|` or `>-` is not a value);
- in a dotenv file (`.env`, `.env.<word>`, `*.env`), a YAML file and a shell
  script or Dockerfile - known from `options.path` or `options.fileKind` - any other environment-style
  name that is, or ends in, a credential word (`DB_PASSWORD`,
  `STRIPE_SECRET_KEY`, `GITHUB_TOKEN`, `SECRET_KEY`, `APP_PASSPHRASE`,
  `…_API_KEY`, `…_ENCRYPTION_KEY`, `…_CLIENT_SECRET` and the like; not a bare
  `…_KEY`, `PWD`, `PASS` or `…_CREDENTIALS`, which hold paths), at the start of
  a line: `NAME=v` and `NAME = v` in dotenv (any case), `NAME: v` and a compose
  `- NAME=v` item in YAML, and `NAME=v` after `export`, `declare -x`,
  `readonly`, `local`, `ENV` or `ARG` in a script. In dotenv and YAML the value
  is the rest of the line minus a ` # comment`; in a script one shell word.
  YAML syntax (`|`, `>`, a bare `!tag`, `&anchor` or `*alias`) is never a
  value. Unlike the fixed names above, the value is judged as the quoted
  `password = "…"` form is: a strong value is redacted (a passphrase and a
  number of 8 or more digits included); a value under 6 characters (a boolean,
  a short number, `~`), a reference (`${DB_PASSWORD}`, `$X`), a command
  substitution and a file path (`./keys/jwt.pem`, `$HOME/key.asc`) are not
  values; a weak value is reported as a possible credential and left as
  written, or, when it is a default word, masked as a name. A file kind never
  relaxes a test file, but it can turn a weak value that was masked as a name
  into one reported and left as written. Quoted values have no length limit
  but are read on one line. A
  unified-diff line (`+`, `-` or a space first) is read as the line it holds. Without a `path` or `fileKind`, and in source, Markdown or other
  files, these names are read as before. Not covered yet: assignments in the
  middle of a line (`docker run -e NAME=v`), PowerShell `$env:`, cmd `set`,
  fish `set -x`, `setx`, a quoted value spanning lines, the body of a YAML
  block scalar, and the Kubernetes
  `name:` / `value:` pair;
- the password in URL userinfo (`scheme://user:password@host`, the user may be
  empty), never the user or the host;
- auth headers: `Authorization` / `Proxy-Authorization` with `Bearer` from 8
  characters or `Basic` credentials of any length, `X-Api-Key` with a literal
  value (one that starts at a code root such as an environment lookup,
  `config.`, `settings.`, `secrets.`, `$` or `{{` is left alone; a JWT never
  is), the same inside curl `-H`, and the password of curl
  `-u user:pass`.

The user half is a credential too when it is a token (`https://<token>@host`,
curl `-u <token>:`, the user of `Basic` credentials): a user that holds a
provider-format key, or passes the engine's high-entropy token test (24+ token
characters), is redacted in every file. A user name stays, however long or
mixed (`deploy_user_2024`, `Build-Agent01`, `x-access-token`).

Obvious placeholders are neither redacted nor reported: `changeme`,
`password`, `xxx…`, `***`, `<your-password>`, `<your password>`, `${VAR}`,
`${VAR:?message}`, `${{ secrets.X }}`, `{{ x }}`, `$VAR`, `%VAR%`, `$(…)`,
`REDACTED`, an ellipsis, an empty value. A placeholder that spans spaces is
taken whole, and only when it is the whole value: `<pw>hunter2` is a value. In
`${VAR:-default}` (and `-`, `:=`, and Spring's `${VAR:default}`) the default
is the value and is judged as one, spaces included.

**Redaction by context.** Pass the file the text came from as `path`
(`anonymize(code, { path })`, `scanSecrets(code, policy, { path })`,
`detectSecrets(code, { path })`), relative to the project. For an absolute
path, also pass the project `root`: only folders inside it count, and without
it only the file name does, so `/home/test/app/src/db.ts` is real source. In a
test, fixture or example file
(`isExamplePath`: `test/`, `tests/`, `__tests__/`, `fixtures/`, `examples/`,
`*.test.*`, `*.spec.*`, `*_test.*`, `.env.example`, `.env.sample`, `*.example`
and similar) a **weak** value in one of these positions is only reported, as a
`possible-credential` finding that does not block: there it is a fixture, and
destroying it would corrupt the test. A **strong** value (12+ characters of
three character classes, or 20+ near-random characters) is redacted there as
everywhere. A `user:password` pair (Basic, URL userinfo, curl `-u`) is judged
half by half, never as the joined string: the password half alone decides,
as for `PGPASSWORD`, and a token-shaped user is redacted on its own. The
verdict holds where the generic `password = "..."` rule reads the same value,
so a quoted weak value in a test file is report-only too. With no `path` the
text is treated as real source and every value in these positions is
redacted. The generic `password = "..."` rule keeps its own judgement
elsewhere (a single lowercase word there is only reported, in any file).

## Regulated identifiers

A bank account or card number is not a credential — it is material a regulation
cares about, and it is what this tool is most often reached for. It is also not
an identifier a grammar produced, so `const iban = "GB29…"` had its **name**
masked and its **value** passed through verbatim.

Three formats are found by arithmetic over the value — never by inference, which
would cost the zero-dependency guarantee — and masked **reversibly**, into the
same map, so the round trip returns them:

| Finding        | Placeholder  | Confirmed by           |
| -------------- | ------------ | ---------------------- |
| `iban`         | `__IBAN__n`  | IBAN mod-97 check      |
| `payment-card` | `__PAN__n`   | issuer prefix and Luhn |
| `pesel`        | `__PESEL__n` | PESEL check digit      |

```ts
const { anonymized, map } = anonymize('const acct = "GB29NWBK60161331926819"')
// anonymized → 'const __VAR__1 = "__IBAN__1"'
// restore(anonymized, map).restored → the original line, account number included
```

Each format gets its own placeholder base rather than a shared one, because the
output's job is to be worked on by a model: "this is a bank account number" is
information it can use, where "this is a redacted something" is not. Published
test card numbers are not flagged at all — a fixture is not a leak.

Three rules bound what the reversibility can cost:

- **A credential wins.** Where a credential rule reads the same span — a
  password assignment, a connection string, a bearer token — the value is
  destroyed rather than masked, so it never reaches the map. An ambiguous
  verdict (`possible-credential`) is destroyed too: masking might write a live
  secret into the map, and reporting it would send that secret to the model
  verbatim.
- **A manual mark wins.** A value already marked by hand keeps its
  `__MANUAL__n` placeholder rather than gaining a second one.
- **They do not block a paste.** `hasBlockingSecrets` exists to stop a live
  credential reaching a model; refusing the billing code this tool was built for
  is not that.

Under `'warn'` and `'off'` these values are left in place like any other finding
— masking them is part of acting on a scan, not part of reporting one.

## Privacy & security properties

This package is the security-critical core of Veilio, and is designed to be
audited:

- **Local only.** No network calls, ever — it is a pure in-process transform.
- **No telemetry.** It reads no environment, sends no analytics.
- **Zero runtime dependencies.** Nothing is pulled in at install time.

These invariants are enforced in CI by `tests/purity.test.ts`.

Custom rule patterns run on a linear-time matcher, not on the platform's regular expressions, so a pattern cannot make matching take more than time proportional to the text.

## API

- `anonymize(code, options?)` → `{ anonymized, map, identifierCount, language, languageFallback, secrets, comments, rulesStopped }`
  - `options.language` — a language name or `'auto'` (default)
  - `options.secrets` — `'redact'` (default) | `'warn'` | `'off'`
  - `options.path` — the file the code came from; a weak password in a secret
    position is only reported in a test, fixture or example file (see above)
  - `options.root` — the project root, for an absolute `path`
  - `options.fileKind` — `'dotenv'` | `'yaml'` | `'shell'` | `'ini'` | `'xml'` | `'pgpass'` | `'text'`, for a caller that
    knows the file but passes no `path` (`fileKindOf(path)`): turns on the
    environment-style credential rules for that kind (dotenv, YAML, shell) and
    where its grammar keeps values (every kind; `text` reads by every grammar) - it never relaxes a test file. Adds to the kind a `path` implies; it never replaces it.
    Text of no kind - `text`, or no path and no language the text reads as -
    is read by every value grammar: `DB_PASSWORD=Summer2024!` pasted on its own
    is redacted whole.
  - `options.existingMap` — continue numbering from a previous session:
    `anonymize(next, { existingMap: map })`
  - `options.team` — `{ blocks, tag, retired? }`, a team checkout's numbering:
    each new number of a base comes from its reserved block while one is left,
    and otherwise from the checkout's local family (see "Names numbered without
    a team block"). `retired` lists placeholders a publish moved out of the map
    (`aliases.json`); numbering stays above them, so none is minted again for
    another name. A tag that is not six of `A-Z0-9` throws a TypeError.
    Without it, numbering is unchanged
  - `options.ruleBudget` — a `ruleBudget()` the call draws its rule-matching
    steps from, for a caller that shares one allowance across several calls
    (the guard does, per hook invocation). Without it, each call gets its own
  - `options.rules` — whitelist / named-replacement rules. Team whitelists
    name the identifiers they keep (`^Name$` or `^(NameOne|NameTwo)$`).
    Personal whitelists may use any supported pattern.
  - `options.manual` — literal strings to mask by hand (see below)
  - an unknown key throws a TypeError that names it and lists the valid
    options. It used to be ignored, or worse: an object of unknown keys was
    taken as a positional map, so `{ style: 'plain' }` (an option removed
    before 1.0.0) was stored in the map. `restore`, `scanSecrets` and
    `detectSecrets` check their options the same way.
  - `anonymize(code, existingMap)` — the positional map form is deprecated;
    pass `{ existingMap }`. An object whose keys are all placeholders is still
    read as a map. The form is removed in the next major version.
  - `comments` — `{ total, inline, characters, severity }`: how much comment
    text left **as written**. In comments only names the map holds are masked,
    which makes the rest the largest thing the engine does not do for you —
    reported rather than left to be discovered. `inline` counts blocks sitting after the
    file's first line of code; a licence header above it grades `low`, anything
    in the body grades `medium`, and it never goes higher: the engine cannot
    read the prose, so it never claims a comment _is_ sensitive. Consecutive
    line comments count as one block; blocks with no letters or digits in them,
    and placeholders (for a name the map holds, or a term marked by hand), are
    not counted.
  - **Throws `ManualMaskError`** when a term in `options.manual` scans as a
    credential, is already a placeholder, or is a keyword in the resolved
    language. Marks replayed from `existingMap` never throw — a mark made in one
    language must not make a file in another language impossible to anonymize.
- `restore(text, map, options?)` → `{ restored, strippedItems, strippedCount, report }`
  - `options.strip` — which AI artifacts to remove: `'all'` (default), `'none'`,
    or an explicit list of `StrippedItemType`. Worth setting: `'all'` deletes
    JSDoc, and when a model was _asked_ to document its output that is
    destroying requested work rather than removing noise.
  - `report` — `{ resolved, missing, unresolved, altered }`: which placeholders
    came back, which never appeared, which placeholder-shaped tokens the map
    cannot explain, and which placeholders the model changed the case or
    underscores of (`__fn__1`, `_FN__1`) — no map can restore those. A model that
    renames `__FN__1` leaves no trace in the restored text, so `missing` is the
    only place that failure is visible. `altered` is new in 1.8.0 and always
    present: code that builds a report by hand (a test fixture, say) needs
    `altered: []` to type-check.
- `alteredPlaceholders(text)` → `string[]` — the `altered` rule on its own:
  tokens of a kind the engine mints (`CLS`, `FN`, `VAR`, `PKG`, `STR`, `MANUAL`,
  `IBAN`, `PAN`, `PESEL`) with changed case or underscores. An ordinary name
  (`tmp_fn_1`), a dunder or a redacted credential never matches.
  `alteredPlaceholders(text, map)` also leaves out the map's real names, as
  `restore()` does: your own `_str_1` restored exactly is not altered.
- `isPlaceholder(token)` → `boolean` — whether a string is a placeholder this
  engine could have produced. For validating a map that arrived from somewhere
  else before trusting its keys.
- `manualTermsIn(map)` → `string[]` — terms previously marked by hand
- `MANUAL_BASE` / `ManualMaskError` — the manual placeholder base, and the error
  thrown when a mark is refused

### Marking spans by hand

Custom rules can only rename identifiers the extractor already found. That
leaves out the two things most often needing masking: a name that stands only
in a comment — a person, a customer — and a bare account or case number. Both are prose as far as extraction is
concerned.

```ts
anonymize('// escalated by Kowalska, acct 88412037', {
  manual: ['Kowalska', '88412037'],
})
// → '// escalated by __MANUAL__1, acct __MANUAL__2'
```

Matching is literal, case-sensitive and longest-first, and runs before
extraction — so a marked token beats whatever role the classifier would have
given it. Marks are stored in the map under `__MANUAL__n`, which means
`restore()` reverses them with no special handling and they survive export,
import and sync without a second store. Pass `manualTermsIn(previousMap)` back
in, or just reuse the map as `existingMap`, and prior marks re-apply.

A mark that sits inside a longer name masks the whole name. A name that touches a credential, already holds a placeholder, or stands beside a non-ASCII letter is handled as before.

Three kinds of term are refused with a `ManualMaskError`:

- **A credential.** A manual mask is reversible and is written to the map, so
  masking a live key would persist the secret. Credentials take the one-way
  redaction path instead.
- **An existing placeholder.** Mapping one placeholder to another survives
  `anonymize` and then loses the real name on `restore`, which is a single pass.
- **A keyword in the resolved language.** Marks match literal text anywhere,
  which is the feature — and is why this case is catastrophic rather than merely
  wrong: marking `if` because you read it in a comment rewrites every `if` in the
  code and the file stops compiling.

A mark **replayed from `existingMap`** is never refused for being a keyword. A
map outlives the file it was made against — `def` is an ordinary word in a
TypeScript comment and is Python's grammar — so a stale mark is skipped, not
thrown on. It stays in the map and applies again where it is valid.

- `measureCommentExposure(code, language?)` → `CommentExposure` — the same
  measurement `anonymize` returns, for text it did not produce (after a manual
  mark is undone, say). It reads the text as given, with no map, so it counts a
  name `anonymize` would replace in a comment; the `comments` of an `anonymize`
  result is the figure for what was sent.
- `detectSecrets(code, options?)` → `SecretFinding[]` — scan without modifying
- `scanSecrets(code, policy?, options?)` → `{ findings, code, regulated }` —
  `options.path`, `options.root` and `options.fileKind` as for `anonymize`; `regulated`
  holds the values handed to the masking pass; `anonymize` calls this first and
  masks them itself, so a caller doing its own masking is the only one that needs
  the field
- `REGULATED_BASES` — the placeholder base per regulated format
- `hasBlockingSecrets(findings)` / `summarizeSecrets(findings)`
- `isExamplePath(path, root?)` → whether a path is a test, fixture or example file
- `fileKindOf(path)` → `'dotenv'` | `'yaml'` | `'shell'` | `'ini'` | `'xml'` | `'pgpass'` | `'text'` | `undefined`: the
  file kind the engine reads a path as (`.env`, `.env.local`, `*.env`; `.yml`;
  `.sh`, a Dockerfile, shell rc files; `.ini`, `.cfg`, `.conf`, `.properties`,
  `.toml`; `.xml`, `.config`, `.xaml`, `.csproj`, `.props`, `.targets`, `.plist`;
  `text` for `.md`, `.mdx`, `.rst` and any other file with no code extension -
  `.txt`, `.tfvars`, `.bat`, a Makefile; `pgpass` for `.pgpass`) - `undefined` for code and data such as
  `.env.ts` or `.env.example.json`
- `detectCredentials(code, options?)` → `detectSecrets`, plus every value
  under a credential-named key that `anonymize` would redact and no rule
  reports (`password: Summer2024!` in text), as `password-assignment`
  findings. Takes `language` too; what `veilio scan` and `scan_secrets` run
- `credentialSpans(code, options?)` → `{ start, end, ambiguous }[]`, every
  credential the rules find, whatever the policy: what `anonymize` keeps out
  of the map. `ambiguous` marks a single word after `password =`
- `redactionTokensOf(scan)` → each value a `scanSecrets` result destroyed, with
  the token that replaced it
- `detectLanguage(code)` / `guessLanguage(code)` → detection with a score
- `extractIdentifiers(code, language?)` → `string[]`
- `withAiPreamble(anonymized, map?)` / `AI_PREAMBLE` — a note to paste above masked
  code so a downstream AI treats the placeholders as intentional.

### Shared team namespaces

Used by the CLI and the MCP server so teammates agree on placeholders. The engine
holds one implementation because two copies can drift between the test asserting
they agree and the next commit, and the symptom would be a team silently forking
its numbering with both repositories green.

- `mergeTeamNamespace(entries)` / `TeamMapEntry` — merge team maps into one
  namespace, oldest first, so an edited map cannot steal a placeholder an older
  one already claimed
- `analyzeTeamNamespace(entries)` → `{ namespace, aliases, conflicts, highest, localDropped }`
  — the same merge, plus what the merge had to decide: the placeholders two maps
  disagree about, the aliases that still restore, and the highest number per
  base so new names are minted above the team's. A `__LOCAL_` key is dropped
  before any of it and counted in `localDropped`: no team map should hold one
- `restoreLayers({ own, team })` → the one restore rule, shared by the web app,
  the CLI and the MCP server: the team's layer under this project's own, with
  `disputedIn(text)` and `locallyNumberedIn(text)` naming the placeholders that
  must be left alone rather than guessed. `disputedNote` / `locallyNumberedNote`
  render the message each caller shows. The team layer never gives a
  `__LOCAL_` placeholder a meaning; `otherLocalIn(text)` names the ones the
  own map lacks (another checkout numbered them), and `localFamilyNote` says so
- `unwrapPrivateKey`, `deriveWrappingKey`, `importPublicKey`, `unwrapTeamKey`,
  `importTeamKey` / `exportTeamKey`, `decryptTeamMap`,
  `decryptTeamMapWithAny`, `encryptTeamMap`, `TeamKeyError` — opening team-key
  envelopes, and sealing one under a key you already hold. Minting a key,
  granting it to a teammate and confirming a teammate's key need a person
  present to approve them and stay in the browser: a client that can open maps
  has no business handing out access to them. Sealing a map is not a grant —
  it widens nothing about who can read the team's maps — which is why a
  terminal may do it.

### Names numbered without a team block

A team member whose tools hold no usable block of reserved team numbers
(refused, offline, a lapsed plan) numbers new names in a family of its own,
`__LOCAL_<TAG>_<KIND>__n` (`__LOCAL_K7Q2XA_VAR__3`). The tag names the
checkout, so two checkouts never mint the same placeholder, and no team map
ever holds one: a teammate leaves it as written, and the next publish gives it
a team number.

- `isLocalPlaceholder(token)` — a numbered placeholder of that family;
  `LOCAL_PREFIX` is its prefix, `__LOCAL_`
- `localBaseOf(base, tag)` / `teamBaseOf(localBase)` — `__VAR__` and
  `K7Q2XA` to `__LOCAL_K7Q2XA_VAR__` and back; `isLocalTag(tag)` is the tag's
  shape, six of `A-Z0-9`
- `isRolePlaceholder(token)` — a role-typed name (`__CLS__n`, `__FN__n`,
  `__PKG__n`, `__VAR__n`, `__STR__n`) in either family
- `usableBlocks(map, blocks)` / `numbersLeft(map, blocks)` /
  `highestPerKind(map)` — which reserved blocks (`Block`, `{ start, end }`)
  a map can still number inside, and how many numbers they have left

### Encrypted `.veilio` files and the vault

The crypto behind CE's export/import and Cloud's map sync lives here so both
editions run the same code — a second implementation of a format that has to
open files the first one wrote is a second thing to get subtly wrong. WebCrypto
only, no dependency added.

- `parseSymbolMap(raw)` → `SymbolMap` — validate an untrusted map before use;
  throws `InvalidMapError`
- `VeilioFile` / `KdfParams` / `parseKdfParams` — the `.veilio` envelope shape
  and its KDF parameters, `CURRENT_FILE_KDF` for what new files get and
  `LEGACY_FILE_KDF` for what older ones still open with
- `assertUsablePassphrase(value)` / `MIN_PASSPHRASE_LENGTH` / `WeakPassphraseError`
  — refuse a passphrase too weak for a file nobody can recover
- `VaultEnvelope` / `parseVaultEnvelope` / `VaultEnvelopeError`,
  `CURRENT_VAULT_KDF` / `LEGACY_VAULT_KDF`, `VAULT_SALT_BYTES`,
  `randomVaultSalt()` — the account vault a personal map is sealed under, so the
  server stores ciphertext it cannot read
- `webCryptoSubtle()`, `randomBytes(n)`, `toBase64` / `fromBase64` — the small
  platform layer the above are built on

### Custom rules sealed under your keys

A custom rule (a name to keep readable, or a pattern to mask under your own
placeholder) is sealed before it leaves your machine, under the same keys as
your maps, so a server storing it cannot read it.

- `sealRuleForVault(key, rule, bind)` / `openRuleFromVault(key, envelope, bind)` — a
  personal rule under the personal-maps key
- `sealTeamRule(teamKey, rule, bind)` / `openTeamRule(keys, envelope, bind)` — a team rule
  under the team key, opened with whichever held version fits
- the last argument names the rule's row, `{ id, teamId }` (a `RuleBinding`);
  it is sealed into the body and checked on opening, so a server that cannot
  read a rule cannot move it to another row either
- opening returns `{ ok: true, rule }` or `{ ok: false, reason }`, never
  throws on bad content. The reason is "unopenable" (wrong key, damaged),
  "not-a-rule" (something else was sealed there) or "refused" (a rule no tool
  may apply, or one sealed for another row)
- `ruleRefusal(rule)` → the sentence why a rule may not be saved or applied,
  or `null`; `isEngineBase(placeholder)` (a placeholder base the engine uses
  for its own names, including anything under `__REDACTED_` or `__LOCAL_`) and `isSafeRegex(pattern)` are the checks it makes
- `compileRulePattern(pattern)` → a matcher whose `test(name)` gives
  the platform regex's answer in time linear in the name's length, or `null` for a
  pattern outside its language. Rule patterns run on it, never on the platform regex, so
  a teammate's pattern such as `(a+)+$` cannot freeze the tool applying it.
  `test(name, budget?)` takes its steps from a `ruleBudget()` when given one.
  One `anonymize` call shares a budget of `RULE_WORK_BUDGET` (50,000,000)
  steps across all its rules and names; once spent, every rule test answers
  "no match" (no name is kept readable or given a rule's placeholder, and an
  ordinary word a replace rule might have matched is masked), and the result
  carries `rulesStopped: true` - `RULES_STOPPED_NOTE` is the sentence to show.
  The language: literals, `.`, classes, `\d \w \s` and their negations,
  `^ $`, groups, alternation, and quantifiers with bounds up to 50.
  Backreferences, lookaround and `\b` are refused; `isSafeRegex` is true
  exactly when this compiles

A lost `.veilio` passphrase is not recoverable, by construction. Nothing here
holds an escrow copy and nothing in the format allows one.

## Known limitations

Names that contain letters outside A–Z are not yet masked whole. A name written only in Greek or Cyrillic letters (for example `παραγγελία`) is not masked at all. A name that mixes A–Z with other letters (for example `wyślijPaczkę` or `größeBerechnen`) is masked only in its A–Z parts, so the other letters reach the model. Names written only in A–Z are not affected. Until this is fixed, rename such names, or leave files that use them out of what you send. Full support is planned for the next release (#224).

## License

Veilio Community License 1.1 — **free to use for any purpose, including inside
your own business commercially.** You may not resell it, host it as a service for
others, rebrand it, or republish it as a product that competes with Veilio Cloud;
for that, contact `hello@veilio.dev`. See the `LICENSE` file. This is a
source-available, community-developed license, not an OSI-approved "open source"
license.
