/**
 * What a passphrase prompt has read so far, with the terminal in raw mode.
 *
 * `esc` holds an escape sequence that has started but not finished: a chunk
 * can end halfway through one, so it is carried to the next.
 */
export interface SecretState {
  value: string
  done: boolean
  cancelled: boolean
  esc?: string
}

/**
 * Take one chunk of raw-mode input into the passphrase being read.
 *
 * Enter (or Ctrl-D) ends it, Ctrl-C cancels, Backspace removes a character.
 * Escape sequences add nothing - above all the bracketed-paste markers
 * (ESC [ 200 ~ and ESC [ 201 ~) that terminals wrap around pasted text. Kept,
 * they made a correctly pasted vault passphrase "not right" (staging walk,
 * 2026-10-25), and arrow keys likewise added invisible characters.
 */
export function feedSecret(state: SecretState, chunk: string): SecretState {
  if (state.done) return state
  let { value } = state
  let esc = state.esc ?? ''
  for (const ch of chunk) {
    if (esc !== '') {
      esc += ch
      // ESC [ ... final byte (0x40-0x7E), or ESC O x, or ESC followed by one char.
      const csi = esc.startsWith('\u001b[')
      const ss3 = esc.startsWith('\u001bO')
      if (
        csi
          ? esc.length > 2 && /[@-~]/.test(ch)
          : ss3
            ? esc.length === 3
            : esc.length === 2 && ch !== '[' && ch !== 'O'
      ) {
        esc = ''
      }
      continue
    }
    if (ch === '\u001b') {
      esc = ch
      continue
    }
    if (ch === '\n' || ch === '\r' || ch === '\u0004')
      return { value, done: true, cancelled: false }
    if (ch === '\u0003') return { value, done: true, cancelled: true }
    if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
    else value += ch
  }
  return esc === ''
    ? { value, done: false, cancelled: false }
    : { value, done: false, cancelled: false, esc }
}
