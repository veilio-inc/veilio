# Contributing to Veilio

## The problem this exists for

Somewhere in a lot of companies' AI policy is a line that reads, roughly, **_don't
paste it._**

It is there for good reasons, and it does not work. What actually happens is one
of two things: the work gets done without the tools, slowly and at a growing
disadvantage — or it gets done with them anyway, quietly, off the record, by
someone in a hurry. Neither outcome is one a security team would choose.

Veilio is an attempt at a third answer: **send the problem, keep the names.**

Real identifiers are rewritten out of your code before the code reaches a model —
`UserAuthService.validateSessionToken` becomes `__FN__1` — and put back when the
answer comes home. The model gets the structure it needs to be useful. It never
gets the account number, the patient, the counterparty, or the client.

```
  what you wrote     wire(acct_88412037, "Kowalska", 45_000, EUR)
  what the model sees  __FN__1(__VAR__1, "__STR__1", 45_000, EUR)
```

The amount and the currency survive, because they carry no identity and the model
needs them to answer. That judgment — what is structure and what is identity — is
the whole of the engineering problem, and it is where contributions land.

## Who this is for

Whole sectors are told to keep their material away from public AI tools. These are
the ones Veilio is built for, and the material actually at issue in each:

| Sector | Material at issue |
| --- | --- |
| Financial services & banking | account numbers · positions · counterparties |
| Insurance | claims · policyholders · actuarial models |
| Government & public sector | citizen records · procurement · case files |
| Healthcare | patient identifiers · clinical notes · device logs |
| Legal services | client names · matter details · privileged drafts |
| Critical infrastructure | network topology · control-system addresses |
| Enterprise R&D | source code · contracts · unreleased roadmaps |

If you work in one of those rows, you are not a hypothetical user. You are the
person who knows what the engine is still missing.

## Who builds it

This Community Edition grew out of a private codebase that was opened up because
a privacy tool nobody can read is a privacy tool nobody should trust. A commercial hosted **Cloud Edition** funds the
work; the core anonymizer is the same code in both, and it lives here, in the
open, where you can audit it before you run it.

That is the deal this project is trying to keep: the thing that inspects your
source code is readable, and the thing that would be worth stealing never leaves
your machine.

## Where a contribution actually lands

The engine is ~3,000 lines. It is small enough that one good pull request moves it
visibly.

- **A language.** Ten today — TypeScript/JavaScript, Python, Go, Java, C#, Rust,
  Ruby, PHP, C and SQL. An eleventh is not a checkbox: it is an entire sector's
  toolchain going from *unusable* to *usable*. COBOL and ABAP are not a joke in
  banking and insurance; Verilog and ladder logic are not a joke in
  infrastructure.
- **A missed identifier.** The engine has to know that `SELECT` is grammar and
  `Kowalska` is a person. Every false negative is a real name reaching a model.
  A failing test case from your own material is worth more than a feature.
- **A false positive.** Masking a reserved word breaks the code the model gets
  back, and a tool that mangles working code gets uninstalled by lunchtime.
- **A credential pattern.** 33 detectors today (AWS, GCP, Azure, Stripe, GitHub,
  Slack, OpenAI, Anthropic, private-key blocks, JWTs…). Note the design: a
  detected credential is **redacted, not masked** — it is replaced by a token that
  never enters the map, so restore cannot bring it back and a synced map can never
  carry a live key. A reversible mask on a secret *stores the secret*.
- **An attack on the crypto.** Exported `.veilio` files are AES-256-GCM with a
  passphrase-derived key. Look at it. Try to break it. Tell us privately
  ([SECURITY.md](./SECURITY.md)) if you do.
- **A report that it failed you.** Open an issue describing what leaked or what
  broke, with material you are allowed to share. That is a contribution.

## Ground rules

- **Be respectful.** Assume good faith; keep discussion technical.
- **One logical change per pull request.** Smaller PRs are reviewed faster.
- **Discuss big changes first.** For anything beyond a bugfix or small
  improvement, open an issue before writing code so we can agree on the approach.
- **Bring a test.** For this project specifically, a test *is* the argument: it is
  the difference between "I think it handles Rust lifetimes" and knowing.

## Engine privacy invariants (do not break these)

`@veilio-inc/engine` is a **pure, local transform: no network, no telemetry, no
environment reads, zero runtime dependencies.** These invariants are enforced in
CI by `packages/engine/tests/purity.test.ts`. A change that violates them will fail
CI and is treated as a security regression — see [SECURITY.md](./SECURITY.md).

This is deliberate and it is not up for negotiation in a PR. For a tool that reads
your source code, the supply chain *is* the product: one transitive dependency
with a postinstall script undoes every other guarantee on this page. If your
change seems to need a runtime dependency, open an issue first — the answer is
usually that it doesn't.

## Contributor License Agreement (CLA)

Veilio is an open-core project: the same anonymizer engine powers both the
source-available Community Edition and the proprietary **Veilio Cloud** edition. So that your
contribution can be used across **both** editions, **every contributor must agree
to the [Contributor License Agreement](./CLA.md) before their first contribution is
merged.**

How to agree: include the following line in the description of your first pull
request (replacing the name and email with your own):

> I have read and agree to the Veilio CLA (CLA.md). Signed-off-by: Your Name <you@example.com>

We may also use an automated CLA check on pull requests. You only need to agree once.

## Developer Certificate of Origin (DCO)

In addition to the CLA, please sign off your commits to certify you wrote the code
or have the right to submit it (see https://developercertificate.org). Add a
sign-off automatically with:

```bash
git commit -s -m "your message"
```

## Development setup

```bash
npm install      # also builds the bundled engine via the postinstall script
npm run dev       # start the Vite dev server
```

Useful checks before opening a PR:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test           # runs the Vitest suite, including the engine purity tests
```

`npm run lint:fix && npm run format` fixes most of what the first two complain
about. A `pre-push` hook runs `lint` and `format:check` for you, so a push that
would fail CI on formatting fails locally instead.

## Reporting bugs and vulnerabilities

- **Bugs / features:** open a GitHub issue.
- **Security vulnerabilities:** do **not** open a public issue — follow the private
  process in [SECURITY.md](./SECURITY.md).

## License of contributions

Unless stated otherwise, your contributions to this repository are provided under
its **[Veilio Community License 1.0](./LICENSE)** — free to use, modify, fork, and
run inside your own business, including commercially; not for reselling or hosting
as a competing service. Per the [CLA](./CLA.md), you also grant the rights needed
to use your contribution in Veilio Cloud and in commercially-licensed
distributions. The **"Veilio" name and logo** are not covered by the software
license — see [TRADEMARKS.md](./TRADEMARKS.md).
