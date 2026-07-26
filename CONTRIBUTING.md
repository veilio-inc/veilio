# Contributing to Veilio

Thanks for your interest in improving Veilio! This repository is the **Community
Edition (CE)** — the source-available, self-hostable app and the `@dlgshi/engine`
anonymizer, licensed under PolyForm Shield 1.0.0 (free to use for any purpose,
including commercially; not for competing resale). Contributions are welcome.

## Ground rules

- **Be respectful.** Assume good faith; keep discussion technical.
- **One logical change per pull request.** Smaller PRs are reviewed faster.
- **Discuss big changes first.** For anything beyond a bugfix or small
  improvement, open an issue before writing code so we can agree on the approach.

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
npm test           # runs the Vitest suite, including the engine purity tests
```

## Engine privacy invariants (do not break these)

`@dlgshi/engine` is a **pure, local transform: no network, no telemetry, no
environment reads, zero runtime dependencies.** These invariants are enforced in
CI by `packages/engine/tests/purity.test.ts`. A change that violates them will fail
CI and is treated as a security regression — see [SECURITY.md](./SECURITY.md).

## Reporting bugs and vulnerabilities

- **Bugs / features:** open a GitHub issue.
- **Security vulnerabilities:** do **not** open a public issue — follow the private
  process in [SECURITY.md](./SECURITY.md).

## License of contributions

Unless stated otherwise, your contributions to this repository are provided under
its **PolyForm Shield License 1.0.0**, and, per the [CLA](./CLA.md), you also
grant the rights needed to use them in Veilio Cloud and in commercially-licensed
distributions. The **"Veilio" name and logo** are not covered by the software
license — see [TRADEMARKS.md](./TRADEMARKS.md).
