# Roadmap — Veilio Community Edition

_Last updated 2026-08-15._

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
| A4 | Self-host the web fonts | **done** |

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

**A4 — done.** `index.html` loaded Crimson Pro, Inter and JetBrains Mono from
Google Fonts. Every page load therefore disclosed the user's IP address and
User-Agent to a third party — from a tool whose entire argument is that nothing
leaves your machine. It also broke the air-gapped install in A2, where the fonts
simply failed to resolve.

The nine faces in use are now vendored as woff2 under `public/fonts/`, declared
with local `@font-face` rules and `font-display: swap`. The app makes **no
external requests at all**, which is what makes the strict CSP in E3 possible:
with a third-party font host, `style-src`/`font-src` would have had to name it.

**This entry previously estimated "roughly 200 kB". That was wrong.** Measured:
nine faces × latin and latin-ext = **18 files, 761.5 kB on disk**, which took the
image from 10.4 MB to 12 MB. The estimate had not accounted for latin-ext, and
Inter's is unusually large at 83 kB per weight.

Page weight is the number that actually matters, and it is much smaller: the
`unicode-range` on each rule means a browser fetches only the subsets it needs.
A measured English page load fetches **7 of the 18 files**, and they are cached
immutably for a year. Dropping latin-ext would have saved disk at the cost of
correctly rendering Polish, Czech and Hungarian text, which is a poor trade for a
tool sold into the EU.

All three families are SIL Open Font License 1.1. Each upstream licence is
reproduced verbatim beside the fonts (`public/fonts/OFL-*.txt`) as that licence
requires, with `README.txt` recording what is vendored and why.

The Privacy and Cookie notices previously disclosed the Google Fonts request.
Both now state that CE makes no third-party requests, at document version 1.2.

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

| | Item | State |
| --- | --- | --- |
| C1 | A CLI consuming the published engine | needs design |
| C2 | An MCP server taking file paths, not blobs | needs design |

Both consume the published engine. An MCP tool that takes a *file path* rather
than a blob means masked code reaches the agent while the real identifiers never
enter its context.

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

## E — Security and supply chain

A tool that reads your source code is only worth its claims if the claims are
enforced rather than asserted. This section came out of a full audit of the
repository on 2026-08-14; every item below is a finding from it, including the
ones we have not fixed yet.

| | Item | State |
| --- | --- | --- |
| E1 | Patch the shipping router advisory | **done** |
| E10 | Decide on React Router 7 | needs design |
| E2 | Least-privilege CI token | **done** |
| E3 | Content-Security-Policy and security headers | **done** |
| E4 | Pin actions and base images by digest | **done** |
| E5 | Make the purity gate executable, not textual | **done** |
| E6 | Validate link schemes in rendered documents | **done** |
| E7 | Treat an imported map as untrusted input | **done** |
| E8 | Passphrase strength, and a tighter KDF ceiling | **done** |
| E9 | Provenance for the container image | **done** |
| E11 | Derive off the main thread | ready |

**E1 — done.** `@remix-run/router` shipped in the bundle at a version inside the
range for [GHSA-2j2x-hqr9-3h42](https://github.com/advisories/GHSA-2j2x-hqr9-3h42),
an open redirect via protocol-relative URL reinterpretation. The fix was inside
the existing semver range — `react-router-dom` 6.30.3 → 6.30.4 — so it cost a
lockfile bump and nothing else. Everything else `npm audit` reports is a
devDependency that never reaches a user.

**`npm audit` does not come back clean, and that is a decision rather than an
oversight.** Two advisories remain against `react-router`, and their affected
range is `6.0.0 - 7.17.0` — there is no 6.x that clears them. Neither is
reachable here:

- *Arbitrary constructor injection via `deserializeErrors()` in SSR hydration.*
  CE has no SSR. It mounts with `createRoot` and ships as a static bundle, so the
  hydration path the advisory describes does not exist in this app.
- *Open redirect via backslash in `<Link>` and `useNavigate`.* Every navigation
  target in the app is a hard-coded literal — `/`, `/pricing`, `/dashboard`, a
  module constant in the footer, and `/legal/<slug>` where the slug is checked
  against an allow-list before use. Nothing user-controlled reaches a navigation
  API.

See E10 for the standing decision.

**E10.** Clearing the two advisories above means React Router 7, which is a major
migration for a four-route application. We have not taken it, because the
advisories are not reachable (E1) and a rushed major upgrade of the routing layer
is a larger risk to correctness than the thing it would silence.

The cost of that choice is honest and worth stating: `npm audit` reports two
moderate findings, and anyone running it — including a prospective customer's
security review — will see them. This entry exists so the answer is written down
rather than reconstructed each time. Revisit when the app grows a route with a
user-controlled destination, when an advisory becomes reachable, or when v7 is
warranted on its own merits.

**E2 — done.** `ci.yml` declared no `permissions:` block, so it ran with whatever
the repository default grants rather than least privilege. It now starts from
`contents: read`, matching the posture `publish-engine.yml` already had.

**E3 — done.** The app made exactly one network request — same-origin, for a
legal document — and that was a property of the current code rather than an
enforced boundary. It is now enforced: the image serves a
`Content-Security-Policy` of `default-src 'self'` with `connect-src 'self'`,
alongside `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options` and
`frame-ancestors 'none'`.

This is the difference between "we do not exfiltrate your source" and "we
cannot", and it is the reason A4 had to come first: while the fonts were loaded
from a third party, the policy would have had to name that third party and the
guarantee would have been correspondingly weaker.

`docker/nginx.conf` carries the same headers, since the README points
self-hosters at it as the reference for serving the release tarball.

**E4 — done.** Every GitHub Action was pinned to a mutable major tag — `@v5`,
`@v3`, `@v6` — and so were the `node:24-alpine` and `golang:1.24-alpine` base
images. The release job holds `contents: write` and `packages: write`, and the
publish job holds `id-token: write` for npm trusted publishing, so a re-pointed
tag on any of them — including the third-party `softprops/action-gh-release` —
was arbitrary code with permission to publish the package.

All **12** action references across the three workflows are now pinned to a
40-character commit SHA with the released version in a trailing comment, and
both base images to a digest. Verified rather than assumed: each SHA was checked
to resolve in its repository and to carry a tag matching its comment, and the
image builds and passes the full e2e suite from the pinned digests.

Both image digests are multi-arch OCI **indexes**, which is load-bearing — the
release builds `linux/amd64` and `linux/arm64`, and pinning a single-platform
manifest by mistake breaks the arm64 leg at build time rather than at review.

**Pinning alone would have made things worse**, so it did not ship alone. An
immutable pin nobody moves is an unpatched dependency with better provenance;
the risk changes shape rather than going away. `.github/dependabot.yml` now
covers Actions, the Docker base images and both npm lockfiles, grouped so the
queue stays small enough to actually read. Updates arrive as a reviewable diff,
which is what a floating tag never offered.

**E5 — done.** The purity invariant was enforced by searching source text for
banned substrings. Its own comment claimed it stopped "a malicious PR", and
against a deliberate one it did not: `globalThis['fet'+'ch']` and
`new Function('return fetch')()` both passed, and the word list did not cover
`localStorage`, `indexedDB` or `document.cookie` at all.

The gate now has two halves. The textual scan stays, with the missing tokens
added and comments stripped before scanning — this engine documents what it
looks for in *users'* code, so prose legitimately mentions `import(...)`, and a
token in a comment executes nothing. String literals are deliberately kept, so
`globalThis["fetch"]` is still caught.

The second half executes. Every network and storage global is replaced with a
recording accessor, and the engine is run through a full anonymize/restore
cycle — including deliberately hostile input. Because *any* route to a global is
ultimately a property read on the global object, computed names and indirect
`Function` construction are caught along with the literal spelling.

**The first version of this was wrong in an instructive way.** It trapped only
function calls, so a probe that captured `fetch` at module scope — the obvious
way to write the thing the gate exists to stop — passed cleanly. The suite now
re-imports the engine with the traps already installed, and that case fails as
it should. Verified by injecting
`globalThis[String.fromCharCode(102,101,116,99,104)]` into `engine.ts`,
confirming zero literal occurrences of `fetch(`, and watching the gate fail;
then reverting.

A test that has never failed proves nothing, so one test asserts the trap
mechanism itself fires. Without it a broken `defineProperty` would turn the
whole suite into assertions that cannot fail.

**E6 — done.** The dependency-free markdown renderer behind `/legal/*` took an
`href` straight from the document. React 18 warns about `javascript:` URLs and
renders them anyway. The documents are ours, so nothing was exploitable — but
this is a source-available repository that accepts pull requests, and a legal
notice is an unremarkable file to skim.

Links are now allow-listed to `https:`, `http:`, `mailto:`, site-relative paths
and in-page anchors; anything else renders as plain text, so the sentence still
reads and nothing navigable is produced.

The check normalises the way a URL parser does before deciding, which is the
part that makes or breaks it: browsers strip leading whitespace and remove tabs,
newlines and carriage returns from *anywhere* in a URL before resolving the
scheme, so `java&#9;script:alert(1)` executes and a naive `startsWith` test waves
it through. It returns the normalised href rather than the original, so the
string tested is the string rendered. Protocol-relative `//evil.example` is
refused too — it reads as a local path and is not one, which is the same
confusion behind the router advisory in E1.

The logic lives in `src/lib/safeHref.ts` rather than inside the renderer so it
can be tested directly, and it carries 17 tests covering each bypass.

**E7 — done.** `importMap` returned whatever a decrypted `.veilio` file
contained. The file is authenticated, so its author knew the passphrase — which
in the team workflow is exactly the point, and therefore proves a colleague wrote
it rather than that the contents are benign. Whatever a map holds is substituted
into restored source, which the reader then pastes into an editor.

The design question was what validation is worth imposing on a format built to be
shared, and the answer is: enough to fail loudly, not enough to pretend the
result is trusted. `src/lib/importedMap.ts` requires placeholder-shaped keys and
string values, bounds entry count and value length, and builds a fresh object
rather than handing back the parsed one — validating one object and returning
another is how a check gets bypassed by a getter or a stray prototype.

Two things fell out of the key check. It must accept the legacy `__P<n>__` style,
or every map exported before role-typed placeholders becomes unimportable — that
is data loss, not hardening. And because the engine's pattern requires an
uppercase first character, it refuses `__proto__`, `constructor` and `prototype`
for free. That is load-bearing rather than incidental, so it is asserted in both
suites; loosening the pattern would silently reopen it.

The shape check is `isPlaceholder()`, newly exported from the engine rather than
duplicated here, so the app and the engine cannot drift on what a placeholder is.

Validation is wired inside `importMap` rather than at the call site, and tested
by removing the wiring and confirming the suite fails — a perfect validator that
nothing calls is the failure mode worth guarding against. The residual risk is
documented in [SECURITY.md](./SECURITY.md): a well-formed map from someone else
can still map `__FN__1` to text you did not write.

**E8 — done, in the two parts that are security.** Nothing required an export
passphrase to be strong, and 600,000 PBKDF2 iterations do not rescue a weak one
once the file leaks and can be attacked offline.

`src/lib/passphrase.ts` sets a floor of 12 characters — counted in code points,
so an emoji passphrase cannot clear it on UTF-16 units alone — and refuses
single-character runs, straight sequential runs and a short list of common
choices. It follows NIST SP 800-63B in putting the lever on length rather than
composition rules, which push people toward predictable substitutions without
adding entropy. It is a floor, not a strength meter, and deliberately returns
nothing: a green tick on a mediocre passphrase is worse than no tick, because it
converts the user's own judgement into misplaced confidence.

It is enforced inside `exportMap`, before any derivation, so no caller can skip
it and a rejected passphrase fails instantly instead of after 600k iterations.
It is deliberately **not** applied on import — a file written by an older build
may be protected by a passphrase this check would now reject, and refusing to
open it is data loss dressed up as hardening. Same reasoning that keeps
`LEGACY_FILE_KDF` frozen.

The hostile-file iteration ceiling drops from 10,000,000 to 4,000,000. The old
value bought no legitimate capability — nothing this project writes exceeds
600,000 — while costing ~17x current derivation on whatever hardware the reader
has. The new ceiling keeps ~6x headroom above current cost, which is more than
any plausible raise before PBKDF2 gives way to a memory-hard KDF entirely. A test
asserts the ceiling can never fall below what this build writes, which is the
invariant that would otherwise make the app unable to read its own exports.

**E11** carries the remaining third of the original item.

**E9 — done.** npm publishes carried provenance through OIDC trusted publishing;
the container image did not, so the artefact most self-hosters actually run had
the weaker chain of custody.

The image now ships two complementary things. BuildKit attestations
(`provenance: mode=max`, `sbom: true`) travel with the image and record the full
build definition — every step, both pinned base-image digests, the build args —
plus an SBOM. And `actions/attest-build-provenance` signs a SLSA statement
through Sigstore against a short-lived OIDC identity, binding the image to this
repository, workflow and commit.

Both were needed. The BuildKit attestation is unsigned metadata: it states what
the build claims, and anyone who can push to the registry can write it. The
signed statement is what a stranger can actually verify, with
`gh attestation verify oci://ghcr.io/veilio-inc/veilio:latest --repo veilio-inc/veilio`.
The README documents both checks, since a provenance nobody knows how to verify
is decoration.

Verified rather than assumed: the image was built locally with the exact flags,
the resulting OCI index unpacked, and the SLSA v1 predicate read to confirm
`mode=max` records the 16-step build definition where `mode=min` records none of
it. The attested image was then run and put through the full e2e suite.

**E11.** Key derivation runs on the main thread, so even a legitimate 600,000
iterations freezes the tab for the duration, and an accepted-but-large value from
an imported file freezes it for longer. Moving the derive to a worker is a
responsiveness fix rather than a security one — E8 bounded the damage, which is
the part that belonged with the security work — so it is tracked on its own
rather than folded into a hardening item where it would overstate what it buys.

**Not doing:** a bug bounty. Handling reports properly requires a response
capacity CE does not have; [SECURITY.md](./SECURITY.md) describes what we can
honestly commit to, which is private disclosure and a fix.

---

## Scope

CE is frontend-only: a static bundle, no backend, no database, no secrets to
manage. That is a deliberate boundary, not a gap waiting to be filled. Proposals
that add a server, multi-user flows or an extensibility surface to CE will be
declined on scope rather than on merit — see [OSS / Cloud
split](./README.md#how-this-relates-to-cloud).

Disagreement with anything above is welcome as an issue. A roadmap nobody argues
with is usually one nobody read.
