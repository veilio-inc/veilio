/**
 * The fake Cloud (fake-cloud.ts), served over real HTTP on 127.0.0.1, so a
 * SPAWNED CLI or MCP server - the built binary, with Node's own fetch - talks
 * to it the way it talks to Cloud. What the fake records is what went over the
 * wire, headers included: no stub between the program and the socket.
 *
 * Spawned with `spawn`, never `spawnSync`: a synchronous child blocks this
 * process's event loop, and with it the server the child is waiting on.
 */
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { FakeCloud } from './fake-cloud.js'

export async function serveOverHttp(
  cloud: FakeCloud
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v
      void cloud
        .fetch(`http://127.0.0.1${req.url}`, {
          method: req.method,
          headers,
          body: body === '' ? undefined : body,
        })
        .then(async (answer) => {
          res.writeHead(answer.status, { 'content-type': 'application/json' })
          res.end(answer.status === 204 ? undefined : await answer.text())
        })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** A credential for the HTTP fake, in `home`. Loopback http is allowed. */
export function credentialFor(
  home: string,
  instance: string,
  extra: Record<string, unknown> = {}
): void {
  mkdirSync(join(home, '.veilio'), { recursive: true })
  writeFileSync(
    join(home, '.veilio', 'credential.json'),
    JSON.stringify({ token: 'tok', account: 'me@example.test', instance, ...extra })
  )
}

/** Run a built binary to completion, asynchronously. */
export function runBinary(
  bin: string,
  args: string[],
  opts: { cwd: string; home: string; input?: string }
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, HOME: opts.home, USERPROFILE: opts.home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr.on('data', (c: Buffer) => (err += c.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
    child.stdin.end(opts.input ?? '')
  })
}
