# Spec — Manual masking and round-trip reporting

_Status: implemented. Written after the engine work and before the UI test pass,
to give the UI acceptance criteria something to be checked against._

## Problem

The engine masks identifiers it can extract. Two categories it cannot reach are
the ones users most need masked:

- **Names in prose.** `// escalated by Kowalska` passes through untouched
  (ROADMAP B3, "the largest remaining silent leak").
- **Bare regulated identifiers.** An account, patient or case number is not
  identifier-shaped (ROADMAP B2).

Custom rules do not help: they are applied inside the loop over already-extracted
identifiers, so they can only rename what extraction already found.

Separately, `restore()` is an exact literal substitution. A model that renames
`__FN__1` produces confident-looking output with its own invention where a real
name belonged, and nothing distinguishes that from a clean run.

## Non-goals

- Guessing what is sensitive. That means an NER/ML dependency, which the engine's
  zero-runtime-dependency invariant rules out.
- Fuzzy-matching mangled placeholders on restore. A case-insensitive scan flags
  every Python dunder; a panel people learn to dismiss is worse than none (B1).
- Recovering a real name the model destroyed. It is not in the response.

## Acceptance criteria

### A. Engine — manual masking

| # | Criterion |
|---|---|
| A1 | A marked term is masked inside a comment |
| A2 | A marked term is masked when it is a bare number |
| A3 | Marks restore losslessly with no change to `restore()` call sites |
| A4 | Overlapping terms resolve longest-first |
| A5 | A mark outranks the role the classifier would assign the same token |
| A6 | Marks re-apply from `existingMap` on a later pass |
| A7 | Marking the same term twice reuses one placeholder |
| A8 | A term scanning as a credential is refused with `ManualMaskError` |
| A9 | The refusal names the offending term |
| A10 | Empty and whitespace-only terms are ignored |
| A11 | A second pass over already-masked output does not renumber |
| A12 | `__MANUAL__` is explained in the legend |
| A13 | A term absent from the source creates the map entry and changes nothing |
| A14 | Every occurrence is masked, not just the first |
| A15 | Regex metacharacters in a term are treated literally |

### B. Engine — restore report

| # | Criterion |
|---|---|
| B1 | A verbatim reply reports everything resolved |
| B2 | A renamed placeholder reports as `missing`, not `unresolved` |
| B3 | An invented placeholder reports as `unresolved` |
| B4 | A re-cased placeholder reports as `missing` (deliberate under-report) |
| B5 | `__REDACTED_*__` tokens are never reported as unresolved |
| B6 | A partial reply reports `missing` without `unresolved` |
| B7 | Repeated unresolved tokens dedupe, first-seen order preserved |
| B8 | Empty map and clean text report nothing |
| B9 | Comment stripping does not disturb the report |

### C. UI — marking a selection

| # | Criterion |
|---|---|
| C1 | "Mask selection" is hidden when nothing is selected |
| C2 | "Mask selection" is hidden in restore mode |
| C3 | Masking a selection replaces it in the output and adds a map entry |
| C4 | Masking a credential shows an error and leaves the output unchanged |
| C5 | The selection clears after a successful mask |
| C6 | Leading/trailing whitespace in a selection is trimmed before marking |

### D. UI — marks panel

| # | Criterion |
|---|---|
| D1 | The panel is absent when there are no manual marks |
| D2 | Each mark shows its placeholder and its real term |
| D3 | Marks are ordered by placeholder number, not insertion or string order |
| D4 | Unmask restores the term in the output and drops the map entry |
| D5 | Unmasking `__MANUAL__1` does not corrupt `__MANUAL__10` |
| D6 | Only `__MANUAL__*` entries appear — not `__FN__`, `__VAR__`, etc. |
| D7 | Each unmask control is distinguishable to a screen reader |

### E. UI — restore report panel

| # | Criterion |
|---|---|
| E1 | The panel is absent when the map is empty and nothing is unresolved |
| E2 | A clean round trip reads as success |
| E3 | Unresolved tokens are shown as a problem |
| E4 | Missing placeholders are shown as information, not as a failure |
| E5 | The count reflects resolved over total |
| E6 | Long token lists truncate with an overflow indicator |

## Validation

Gate: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm run build` all clean.

Result as of 2026-08-12 — 448 tests across 19 files, all passing:

| Area | Before | After |
|---|---|---|
| Total tests | 383 | 448 |
| `packages/engine/src` | 99.6% | 99.6% |
| `src/lib/manualMarks.ts` | — | 100% |
| `src/components/ManualMarksPanel.tsx` | — | 100% |
| `src/components/RestoreReportPanel.tsx` | — | 100% |
| `src/components/CodePanel.tsx` | 0% | 90.2% |
| `src/pages/ScrubPage.tsx` | 0% | 67.2% |
| Overall `src` | 54.0% | 73.1% |

### Browser coverage

jsdom has no layout engine, so `getClientRects` returns nothing and a real text
selection cannot be made there — the entry point to the whole feature. That gap
is closed by a Playwright suite (`npm run test:e2e`): **16 tests, Chromium,
against `vite preview`** so it exercises the built bundle users are actually
served, which is also what the Docker image ships.

Every criterion in groups C, D and E is now checked in a real browser, plus two
that only make sense there:

- a manual mark surviving a full anonymize → mask → restore round trip;
- **no network request carries the source.** The privacy notice's central claim
  is asserted rather than trusted, by recording every request body during a full
  masking session and checking none contains the source or the marked term.

Two traps the browser run exposed, both recorded in `e2e/helpers.ts` because both
produce tests that pass while proving nothing:

- `getByText(...).dblclick()` clicks the centre of the matched element, which for
  CodeMirror is the whole line — usually whitespace, selecting nothing. Word
  selection has to be aimed at measured coordinates.
- `@uiw/react-codemirror` defers external `value` updates for 200 ms after the
  last keystroke (its typing latch), so an editor the page has just cleared can
  still show the old document. Typing without waiting for it to empty appends to
  stale content, and the first draft of these tests did exactly that.

### Still not covered

**Firefox and WebKit.** The suite runs Chromium only.

**Pre-existing, outside this feature:** `SecretPanel.tsx` (21%),
`StrippedPanel.tsx` (18%), `App.tsx` and the other pages remain thinly covered by
unit tests.

## Known limitation, carried deliberately

Manual marking helps with material the author already knows is sensitive and
does nothing for material they have not noticed. B2 and B3 stay open on that
basis: a human in the loop raises the ceiling and does not move the floor.
