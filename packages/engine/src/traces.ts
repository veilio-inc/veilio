// What Node wrote in a stack trace, as opposed to what the user's code wrote.
//
// A trace pasted into a session is masked with the code's map, so the agent can
// tie each frame to a function it has read. Most of a trace is the user's:
// function names, file paths, the messages their own code throws. Those stay
// masked. Some of it is Node's: the fixed wording of V8's error messages and the
// frames inside Node itself. That text names nothing of the user's, and masking
// it turned `Cannot read properties of undefined` into
// `__CLS__2 __VAR__19 __VAR__10 of undefined` - unreadable, for no privacy gain.
//
// The rules are deliberately narrow. Each one matches a whole line, anchored at
// both ends, so V8's wording inside a user's message or a string literal is not
// recognised, and anything that does not match exactly is masked as before.

/** A half-open [start, end) range of text to leave exactly as written. */
export type Span = readonly [number, number]

// V8's messages for the errors an agent is most often asked to read. A slot is
// where the user's name goes: masked like the code. Unquoted slots are a single
// run of non-space characters (`customerRecord.chargeCard`), so a message with
// more text after the wording fails the anchor and stays masked. Longer
// templates come first: the first match wins.
const SLOT = String.raw`(\S+)`
const QUOTED = String.raw`'([^'\n]*)'`
const NULLISH = '(?:undefined|null)'
const TEMPLATES: readonly RegExp[] = [
  `Cannot read properties of ${NULLISH} \\(reading ${QUOTED}\\)`,
  `Cannot set properties of ${NULLISH} \\(setting ${QUOTED}\\)`,
  `Cannot destructure property ${QUOTED} of ${QUOTED} as it is ${NULLISH}\\.`,
  `Cannot access ${QUOTED} before initialization`,
  `${SLOT} is not a function or its return value is not iterable`,
  `${SLOT} is not a function`,
  `${SLOT} is not a constructor`,
  `${SLOT} is not iterable`,
  `${SLOT} is not defined`,
  'Assignment to constant variable\\.',
  'Maximum call stack size exceeded',
].map((t) => new RegExp(`^${t}$`, 'd'))

// `TypeError: …`, `Uncaught ReferenceError: …`, `PaymentDeclinedError: …`. The
// class name is not part of the span: a user's own error class is masked.
const HEADER = /^(Uncaught )?[A-Za-z_$][\w$]*Error: /

// A frame inside Node: `at fn (node:vm:149:12)` or `at node:internal/…:36:49`.
// Everything on it is Node's, including names like `tracePromise.__proto__`.
const NODE_FRAME = /^\s+at (?:async )?(?:\S[^\n]* \(node:[^)\n]*\)|node:\S+)$/

// Inside any other frame, V8's own markers: `<anonymous>` where there is no
// file or no function name, and `(index 0)` on a Promise.all frame.
const FRAME = /^\s+at /
const FRAME_MARKERS = /<anonymous>|\(index \d+\)$/g

/** Ranges of `text` that Node wrote, in order and non-overlapping. */
export function traceVerbatimSpans(text: string): Span[] {
  const spans: Span[] = []
  let lineStart = 0
  for (const line of text.split('\n')) {
    if (NODE_FRAME.test(line)) {
      spans.push([lineStart, lineStart + line.length])
    } else if (FRAME.test(line)) {
      for (const m of line.matchAll(FRAME_MARKERS)) {
        spans.push([lineStart + m.index, lineStart + m.index + m[0].length])
      }
    } else {
      headerSpans(line, lineStart, spans)
    }
    lineStart += line.length + 1
  }
  return spans
}

function headerSpans(line: string, lineStart: number, spans: Span[]): void {
  const header = HEADER.exec(line)
  if (!header) return
  const messageStart = header[0].length
  const message = line.slice(messageStart)
  for (const template of TEMPLATES) {
    const m = template.exec(message)
    if (!m?.indices) continue
    if (header[1]) spans.push([lineStart, lineStart + header[1].length])
    // The message minus its slots.
    let at = 0
    for (const slot of m.indices.slice(1)) {
      if (!slot) continue
      if (slot[0] > at)
        spans.push([lineStart + messageStart + at, lineStart + messageStart + slot[0]])
      at = slot[1]
    }
    if (message.length > at) {
      spans.push([lineStart + messageStart + at, lineStart + messageStart + message.length])
    }
    return
  }
}

/** `text` with every span replaced by spaces: offsets and lines are kept, and
 *  nothing inside a span can be extracted as an identifier. */
export function blankSpans(text: string, spans: readonly Span[]): string {
  if (spans.length === 0) return text
  let out = ''
  let at = 0
  for (const [start, end] of spans) {
    out += text.slice(at, start) + ' '.repeat(end - start)
    at = end
  }
  return out + text.slice(at)
}

/** True when `offset` falls inside one of `spans` (sorted, non-overlapping). */
export function inSpan(spans: readonly Span[], offset: number): boolean {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [start, end] = spans[mid]
    if (offset < start) hi = mid - 1
    else if (offset >= end) lo = mid + 1
    else return true
  }
  return false
}
