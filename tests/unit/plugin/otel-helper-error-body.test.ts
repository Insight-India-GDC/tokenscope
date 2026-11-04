// @vitest-environment node
/*
 * The two PowerShell HTTP calls -- otel-headers-helper.ps1 `Invoke-Http` and
 * claude-redeem.ps1 `Invoke-TsHttpPost` -- run against a local stub, each
 * function lifted out of its script with a SHORT deadline so a stalled body
 * costs seconds, not the real 10 s / 30 s (#418).
 *
 * What each call must do: give connect + headers + body ONE deadline (a server
 * that sends headers and then trickles the body is given up on, Status 0); never
 * follow a redirect; hand back the status and body of ANY response, 4xx/5xx and
 * chunked ones included (5.1's Invoke-WebRequest lost a chunked error body).
 * The end-to-end proof for the helper is the conformance suite's K18/K19, which
 * runs under real 5.1 on the Windows CI job.
 *
 * TOKENSCOPE_PWSH / TOKENSCOPE_SKIP_PWSH as in otel-helper-conformance.test.ts.
 * The file name predates its scope (error bodies are one case); the Windows CI
 * job lists it by name.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolvePwsh } from './helpers/shells.js'

const ROOT = resolve(__dirname, '../../..')
const HELPER = process.env.OTEL_HELPER_PS1_PATH ?? join(ROOT, 'plugin/scripts/otel-headers-helper.ps1')
const REDEEM = join(ROOT, 'plugin/scripts/claude-redeem.ps1')
const SKIP = process.env.TOKENSCOPE_SKIP_PWSH === '1'

// The test deadline, and how long the slow body trickles: well past it, and
// short enough that a function without a deadline still finishes in the test.
const DEADLINE_MS = 1500
const TRICKLE_MS = 8000
// How far past the deadline a give-up may land on a slow runner; well under
// TRICKLE_MS, where a missing deadline would finish.
const SLACK_MS = 3500

function fnText(file: string, name: string): string {
  const src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const m = new RegExp(`^function ${name}\\(.*?\\n\\}\\n`, 'ms').exec(src)
  if (!m) throw new Error(`${name} not found in ${file}`)
  return m[0]
}

interface Hit { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }
const hits: Hit[] = []
let server: http.Server
let base = ''
let closedPort = 0

function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const path = req.url ?? ''
  if (path === '/chunked-401') {
    // No Content-Length: node sends it chunked.
    res.writeHead(401, { 'content-type': 'application/json' })
    res.write('{"statusMessage":')
    return res.end('"instance ended"}')
  }
  if (path === '/s503') {
    res.writeHead(503, { 'content-type': 'text/plain' })
    return res.end('upstream')
  }
  if (path === '/redirect') {
    res.writeHead(307, { Location: '/capture' })
    return res.end()
  }
  if (path === '/capture') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end('{"captured":true}')
  }
  if (path === '/ok') {
    res.writeHead(200, { 'content-type': 'application/json', 'X-TokenScope-Bearer-Expires-At': '1900000000' })
    return res.end('{"ok":true}')
  }
  if (path === '/slow') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"ok":true')
    const started = Date.now()
    const t = setInterval(() => {
      if (Date.now() - started >= TRICKLE_MS) {
        clearInterval(t)
        res.end('}')
      } else {
        res.write(' ')
      }
    }, 250)
    res.on('close', () => clearInterval(t))
    return
  }
  res.writeHead(404)
  res.end()
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => (body += c))
    req.on('end', () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body })
      route(req, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // A port nothing listens on: bind, note it, close.
  const probe = http.createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
  closedPort = (probe.address() as AddressInfo).port
  await new Promise<void>((r) => probe.close(() => r()))
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

interface Out { status: number; body: string; expires?: string; ms: number }

// Async spawn: the stub server lives on this event loop.
function runPs(lines: string[]): Promise<Out> {
  const pwsh = resolvePwsh()
  if (!pwsh) throw new Error('pwsh missing; set TOKENSCOPE_SKIP_PWSH=1 to skip')
  const dir = mkdtempSync(join(tmpdir(), 'ts-ps1-http-'))
  const file = join(dir, 'run.ps1')
  writeFileSync(file, ['Set-StrictMode -Version Latest', "$ErrorActionPreference = 'Stop'", ...lines].join('\n'))
  return new Promise((res, rej) => {
    const c = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file])
    let stdout = ''
    let stderr = ''
    c.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    c.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    c.on('error', rej)
    c.on('close', () => {
      rmSync(dir, { recursive: true, force: true })
      try {
        expect(stderr).toBe('')
        res(JSON.parse(stdout) as Out)
      } catch (e) {
        rej(new Error(`${String(e)}\nstdout: ${stdout}\nstderr: ${stderr}`))
      }
    })
  })
}

const esc = (s: string) => s.replace(/'/g, "''")

// Invoke-Http, with its response reported as one JSON line.
const helperCall = (method: string, url: string, headers = '@{}', body = '$null') => runPs([
  `$HttpDeadlineMs = ${DEADLINE_MS}`,
  fnText(HELPER, 'Invoke-Http'),
  fnText(HELPER, 'Get-ResponseHeader'),
  '$sw = [Diagnostics.Stopwatch]::StartNew()',
  `$r = Invoke-Http '${method}' '${esc(url)}' ${headers} ${body}`,
  '$ms = $sw.ElapsedMilliseconds',
  "[Console]::Out.Write((@{ status = $r.Status; body = $r.Body; expires = (Get-ResponseHeader $r.Headers 'X-TOKENSCOPE-BEARER-EXPIRES-AT'); ms = $ms } | ConvertTo-Json -Compress))",
])

// Invoke-TsHttpPost, likewise.
const redeemCall = (url: string) => runPs([
  `$RedeemDeadlineMs = ${DEADLINE_MS}`,
  fnText(REDEEM, 'Invoke-TsHttpPost'),
  '$sw = [Diagnostics.Stopwatch]::StartNew()',
  `$r = Invoke-TsHttpPost '${esc(url)}' @{ 'X-TokenScope-Setup-Mode' = 'emit-only' } ([Text.Encoding]::UTF8.GetBytes('{"handoff_code":"x"}')) 'application/json'`,
  '$ms = $sw.ElapsedMilliseconds',
  '$b = \'\'',
  'if ($null -ne $r.Bytes) { $b = [Text.Encoding]::UTF8.GetString($r.Bytes) }',
  "[Console]::Out.Write((@{ status = $r.Status; body = $b; ms = $ms } | ConvertTo-Json -Compress))",
])

describe.skipIf(SKIP)('otel-headers-helper.ps1 Invoke-Http', () => {
  it('a body that trickles past the deadline is given up on at the deadline: Status 0', async () => {
    const r = await helperCall('GET', `${base}/slow`)
    expect(r.status).toBe(0)
    expect(r.body).toBe('')
    expect(r.ms).toBeLessThan(DEADLINE_MS + SLACK_MS)
  }, 20_000)

  it('a refused connection is Status 0', async () => {
    const r = await helperCall('GET', `http://127.0.0.1:${closedPort}/x`)
    expect(r.status).toBe(0)
  }, 20_000)

  it('a chunked 401 keeps its status and body', async () => {
    const r = await helperCall('GET', `${base}/chunked-401`)
    expect(r).toMatchObject({ status: 401, body: '{"statusMessage":"instance ended"}' })
  }, 20_000)

  it('a 503 keeps its status and body', async () => {
    const r = await helperCall('GET', `${base}/s503`)
    expect(r).toMatchObject({ status: 503, body: 'upstream' })
  }, 20_000)

  it('a redirect is returned with its own status and never followed, the POST body never re-sent', async () => {
    hits.length = 0
    const r = await helperCall('POST', `${base}/redirect`, '@{}', "'refresh_token=x'")
    expect(r.status).toBe(307)
    expect(hits.map((h) => h.path)).toEqual(['/redirect'])
  }, 20_000)

  it('a 200 hands back the body and the response headers, read case-insensitively', async () => {
    const r = await helperCall('GET', `${base}/ok`)
    expect(r).toMatchObject({ status: 200, body: '{"ok":true}', expires: '1900000000' })
  }, 20_000)

  it('the request carries the given headers; a POST carries the form body, with no Expect', async () => {
    hits.length = 0
    await helperCall('GET', `${base}/ok`, "@{ Authorization = 'Bearer a-token'; 'X-TokenScope-Plugin-Version' = '1.2.3' }")
    expect(hits[0].headers.authorization).toBe('Bearer a-token')
    expect(hits[0].headers['x-tokenscope-plugin-version']).toBe('1.2.3')
    expect(hits[0].headers['user-agent']).toMatch(/^TokenScope-PowerShell\/\d+\.\d+$/)
    hits.length = 0
    await helperCall('POST', `${base}/ok`, '@{}', "'grant_type=refresh_token&refresh_token=a%2Bb'")
    expect(hits[0].method).toBe('POST')
    expect(hits[0].body).toBe('grant_type=refresh_token&refresh_token=a%2Bb')
    expect(hits[0].headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(hits[0].headers.expect).toBeUndefined()
  }, 20_000)
})

describe.skipIf(SKIP)('claude-redeem.ps1 Invoke-TsHttpPost', () => {
  it('a body that trickles past the deadline is given up on at the deadline: Status 0', async () => {
    const r = await redeemCall(`${base}/slow`)
    expect(r.status).toBe(0)
    expect(r.ms).toBeLessThan(DEADLINE_MS + SLACK_MS)
  }, 20_000)

  it('a redirect is returned with its own status and never followed', async () => {
    hits.length = 0
    const r = await redeemCall(`${base}/redirect`)
    expect(r.status).toBe(307)
    expect(hits.map((h) => h.path)).toEqual(['/redirect'])
  }, 20_000)

  it('a 200 hands back the body; the POST carries JSON and the setup-mode header', async () => {
    hits.length = 0
    const r = await redeemCall(`${base}/ok`)
    expect(r).toMatchObject({ status: 200, body: '{"ok":true}' })
    expect(hits[0].body).toBe('{"handoff_code":"x"}')
    expect(hits[0].headers['content-type']).toBe('application/json')
    expect(hits[0].headers['x-tokenscope-setup-mode']).toBe('emit-only')
  }, 20_000)

  it('a chunked 401 keeps its status', async () => {
    const r = await redeemCall(`${base}/chunked-401`)
    expect(r.status).toBe(401)
  }, 20_000)
})
