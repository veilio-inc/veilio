import { describe, it, expect } from 'vitest'
import { feedSecret, type SecretState } from '../src/secret-input.js'

/**
 * Reading a passphrase with the echo off.
 *
 * Found on the staging walk (2026-10-25): a vault passphrase PASTED at
 * `veilio team unlock` was "not right" although it was. Terminals wrap a paste
 * in bracketed-paste markers (ESC [ 200 ~ ... ESC [ 201 ~), and the raw-mode
 * reader kept them as part of the passphrase.
 */
const start: SecretState = { value: '', done: false, cancelled: false }
const feed = (...chunks: string[]) => chunks.reduce((s, c) => feedSecret(s, c), start)

describe('feedSecret', () => {
  it('a pasted passphrase arrives without the bracketed-paste markers', () => {
    expect(feed('\u001b[200~Correct-Horse_9!\u001b[201~', '\r')).toEqual({
      value: 'Correct-Horse_9!',
      done: true,
      cancelled: false,
    })
  })

  it('the markers may arrive split across chunks', () => {
    expect(feed('\u001b[2', '00~abc', '\u001b[20', '1~', '\n').value).toBe('abc')
  })

  it('a typed passphrase is unchanged, and Enter ends it', () => {
    expect(feed('s3cr', 'et', '\r')).toEqual({ value: 's3cret', done: true, cancelled: false })
  })

  it('other escape sequences - arrow keys - add nothing', () => {
    expect(feed('ab', '\u001b[D', '\u001b[C', 'c', '\r').value).toBe('abc')
  })

  it('Backspace removes the last character', () => {
    expect(feed('abd', '\u007f', 'c', '\r').value).toBe('abc')
  })

  it('Ctrl-C cancels', () => {
    expect(feed('abc', '\u0003')).toMatchObject({ cancelled: true, done: true })
  })

  it('nothing after Enter is taken', () => {
    expect(feed('abc\rdef').value).toBe('abc')
  })
})
