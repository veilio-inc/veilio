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
| A1 | Shrink the runtime image | **done — 77.4 MB → 10.4 MB** |
| A2 | Cut a version tag so the Releases tarball exists | ready |
| A3 | Vulnerability scan as a release gate | ready |
| A4 | Self-host the web fonts | ready |

**A1 — done, in two steps.**

The image was 77.4 MB, of which 76.8 MB was the `nginx:1.27-alpine` base. The
site is 1.1 MB, so the distro was roughly 99% of what anyone pulled.
`alpine-slim` took it to 21.7 MB. Then nginx went too: the image is now a
~140-line standard-library static server ([`docker/serve.go`](./docker/serve.go))
on `scratch` — **10.4 MB**, of which 5.8 MB is the Go binary and 1.5 MB the site
plus its pre-built gzip sidecars.

**This roadmap previously said we would not do that.** The stated objection was
that a busybox or distroless runtime costs gzip, the cache-control rules, and an
nginx config a self-hoster can read and adapt. That turned out to be addressable
rather than fundamental, so the entry changed:

- The server implements all four behaviours the nginx config specified — SPA
  fallback returning **200** (busybox httpd's `E404` returns 404, which is the
  trap), `immutable` caching for fingerprinted assets, `no-store` for
  `index.html`, and gzip served from sidecars built at image time.
- [`docker/nginx.conf`](./docker/nginx.conf) stays in the repo and stays
  correct, as the reference for serving the release tarball behind an nginx you
  already run.
- Only the standard library is used. A tool whose argument is supply chain
  should not pull in a third-party server to save megabytes.
- The image now contains no shell, no package manager and no distro to patch.

Verified against a running container: all routes, deep-link routing, gzip
negotiation including `gzip;q=0`, both cache-control rules, path traversal
(rejected — falls back to the app, nothing leaks), `POST` → 405, and the
healthcheck reaching `healthy`.

**Not doing:** chasing the last 5.8 MB. A Rust or C server would reach ~2.5 MB
total, but the remaining bytes are a Go binary we can read, and the difference
between a 10 MB and a 3 MB pull is not something a self-hoster will notice.

**A2.** The README offers a static-bundle install for locked-down and air-gapped
environments, pointing at Releases. There are no releases yet, so that path is
currently a dead end for exactly the users most likely to need it.

**A3.** The image is a static binary plus static files, so its attack surface is
what we compile in rather than a distro. That argues for scanning it on every
publish rather than trusting the tag.

**A4.** `index.html` loads Crimson Pro, Inter and JetBrains Mono from Google
Fonts. Every page load therefore discloses the user's IP address and User-Agent
to a third party — from a tool whose entire argument is that nothing leaves your
machine. It also breaks the air-gapped install in A2, where the fonts simply fail
to resolve. The fix is to vendor the woff2 files into the bundle; the cost is
roughly 200 kB and the removal of the last external request the app makes.

---

## B — Engine

The engine is the product. Everything here is a way it currently falls short.

| | Item | State |
| --- | --- | --- |
| B1 | Make the advisory panel worth reading | ready |
| B2 | Regulated identifiers | **partly addressed — manual marking** |
| B3 | Comments are an open channel | **partly addressed — manual marking** |
| B4 | Language honesty, then coverage | ready |
| B5 | Report what the round trip failed to restore | **done** |

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

**B5 — done.** `restore()` now returns a report of what came back: which
placeholders resolved, which never appeared, and which placeholder-shaped tokens
the map cannot explain. A model asked to echo placeholders verbatim is under no
obligation to comply, and when it renames one the restored text looks exactly as
confident as a clean run. That failure was previously invisible.

**Manual marking, and what it does not solve.** B2 and B3 are both cases of the
engine not seeing something. Rather than teach it to guess — which would mean the
ML dependency ruled out below — the author can now mark a span by hand and have
it masked as literal text, anywhere in the file, comments included. The mark is
stored in the map, so it restores and syncs like any other placeholder.

This is a real answer for material you already know is sensitive, and no answer
at all for material you have not noticed. Both items stay open on that basis: a
human in the loop raises the ceiling and does nothing for the floor.

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
