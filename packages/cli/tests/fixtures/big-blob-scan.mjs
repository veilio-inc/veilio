// Run `veilio scan --blobs` (the built CLI, in this process) on a generated
// stream holding one 50 MB blob, and print the exit code and peak RSS in MB.
// argv: <listing file> <"text"|"binary">. Nothing is held: the stream is made
// as it is read.
import { main } from '../../dist/index.js'
const [listing, kind] = process.argv.slice(2)
const ID = 'ab'.repeat(20)
const SIZE = 50 * 1024 * 1024
async function* stream() {
  yield Buffer.from(`${ID} blob ${SIZE}\n`)
  const chunk = Buffer.alloc(1024 * 1024, 'a')
  if (kind === 'binary') chunk[0] = 0
  for (let sent = 0; sent < SIZE; sent += chunk.length) {
    yield Buffer.from(chunk)
    chunk[0] = 0x61
  }
  yield Buffer.from('\n')
}
let err = ''
const code = await main(['scan', '--quiet', '--blobs', listing], {
  cwd: process.cwd(),
  stdin: async () => '',
  stdinBytes: stream,
  stdout: () => {},
  stderr: (t) => (err += t),
})
const rssMb = Math.round(process.resourceUsage().maxRSS / 1024)
process.stdout.write(JSON.stringify({ code, rssMb, err }))
