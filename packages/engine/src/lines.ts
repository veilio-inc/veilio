// Line positions in a text. Internal: not re-exported by index.ts.

/** The offset where each line starts; the first is always 0. */
export function lineIndex(code: string): number[] {
  const starts = [0]
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/** The 1-based line and column of `offset`, from `lineIndex`'s starts. */
export function positionOf(starts: number[], offset: number): { line: number; column: number } {
  // Binary search for the last line start at or before `offset`.
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, column: offset - starts[lo]! + 1 }
}
