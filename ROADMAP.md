# Roadmap — Veilio Community Edition

_Last updated 2026-08-10._

This is the public roadmap for the Community Edition and the anonymizer engine:
what the engine gets wrong today, what we intend to do about it, and what we have
decided not to do. Cloud's commercial work — accounts, teams, billing,
server-side map storage — is not sequenced here and will not be.

There are no dates. Items are ordered by dependency, and a date on a project this
size would be a guess wearing a commitment's clothes. States are honest:
**ready** means designed and unblocked, **needs design** means we know the
problem and not yet the answer.

Where a number appears below, it came from a measurement, not an estimate.

## Already shipped

Listed because a roadmap whose first section is aspirational is not worth much.

- `@veilio-inc/engine` publishes to npm with provenance via OIDC trusted
  publishing — no long-lived token is stored.
- `ghcr.io/veilio-inc/veilio:latest` is published for `linux/amd64` and
  `linux/arm64`, and is public.
- CE and Cloud consume **the same** engine build, rather than two copies that
  drift.

---

## A — Image and install

The first ninety seconds: find the repo, run the thing.

| | Item | State |
| --- | --- | --- |
| A1 | Base the runtime image on `nginx:1.27-alpine-slim` | **done** |
| A2 | Cut a version tag so the Releases tarball exists | ready |
| A3 | Vulnerability scan as a release gate | ready |

**A1 — done.** The image was 77.4 MB, of which 76.8 MB was the
`nginx:1.27-alpine` base; the site itself is 1.1 MB, so the base was very nearly
all of it. On `alpine-slim` it is **21.7 MB**, a 72% reduction from a one-line
change. The slim variant drops the njs, geoip and perl modules; gzip is nginx
core, so compression, the SPA fallback and both cache-control rules are
unaffected — all four were re-checked against a running container.

**A2.** The README offers a static-bundle install for locked-down and air-gapped
environments, pointing at Releases. There are no releases yet, so that path is
currently a dead end for exactly the users most likely to need it.

**A3.** The image is nginx plus static files, so its attack surface is the base
image. That argues for scanning it on every publish rather than trusting the tag.

**Not doing:** a busybox or distroless runtime. It would reach roughly 4 MB, but
costs gzip, the cache-control rules and an nginx config any self-hoster can read
and adapt — to save 17 MB.

---

## B — Engine

The engine is the product. Everything here is a way it currently falls short.

| | Item | State |
| --- | --- | --- |
| B1 | Make the advisory panel worth reading | ready |
| B2 | Regulated identifiers | ready |
| B3 | Comments are an open channel | needs design |
| B4 | Language honesty, then coverage | ready |

**B1.** The overwhelming majority of advisory findings are not actionable. A panel
that cries wolf trains people to dismiss it, which is worse than no panel: the one
finding that mattered arrives in the same grey list as ninety that did not.

**B2.** Account numbers, patient and case identifiers, and similar
domain-specific material can pass through verbatim today. This is the material
the tool is most often reached for, so it should not be the material it handles
least well.

**B3.** Identifiers are replaced; the prose around them is not. A comment naming a
customer, an incident or a person leaves untouched. This is the largest remaining
silent leak and the hardest to bound — a comment is natural language, and the
engine's guarantees rest on it *not* guessing.

**B4.** An unsupported language currently produces a weak result rather than a
refusal. Silence is the wrong failure mode for a privacy tool: say plainly that a
file is unsupported, then widen coverage.

**Not doing:** taking on an NER or ML dependency for B3. The engine has **zero
runtime dependencies**, and that is the whole supply-chain argument for pasting
its output into a model. It outranks the feature.

**Not doing:** bundle splitting. The bundle is 1.04 MB in one chunk (353 kB
gzipped). The concern is real and nobody has ever chosen a privacy tool on gzip
size.

---

## C — Distribution beyond the browser

The web app costs four copy/pastes per turn, and people increasingly work inside
editors and agents rather than a browser tab.

The direction is a **CLI** and an **MCP server**, both consuming the published
engine. An MCP tool that takes a *file path* rather than a blob means masked code
reaches the agent while the real identifiers never enter its context.

This is stated as intent, not as a commitment to a date or a package name. It is
sequenced after the engine work above, because shipping more surfaces on top of
B1–B4 would multiply the same shortcomings across three clients instead of one.

---

## D — Contribution on-ramp

The governance files exist — [CONTRIBUTING](./CONTRIBUTING.md), [CLA](./CLA.md),
[SECURITY](./SECURITY.md), [TRADEMARKS](./TRADEMARKS.md). The last mile does not.

- **Issue templates.** CONTRIBUTING says the most valuable contribution is *"a
  failing test case from your own material"*, and there is currently no form that
  asks for one. A template with input snippet, language, expected and actual turns
  a vague report into something mergeable. Highest-leverage item in this section.
- **PR template** carrying the CLA sign-off line, plus CODEOWNERS and a CLA bot —
  CONTRIBUTING already promises the bot.

---

## Scope

CE is frontend-only: a static bundle, no backend, no database, no secrets to
manage. That is a deliberate boundary, not a gap waiting to be filled. Proposals
that add a server, multi-user flows or an extensibility surface to CE will be
declined on scope rather than on merit — see [OSS / Cloud
split](./README.md#how-this-relates-to-cloud).

Disagreement with anything above is welcome as an issue. A roadmap nobody argues
with is usually one nobody read.
