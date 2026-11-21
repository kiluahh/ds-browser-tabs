// 真实浏览器里验证「扩展 ↔ DSH」这条线：扩展自己轮询 DSH，DSH 看到它在线。
//
// 需要本机 Chrome/Chromium 且允许命令行加载扩展。Google Chrome 158+ 会忽略
// --disable-extensions-except 并拒绝加载命令行扩展，此时本检查会明确跳过，
// 不伪装成通过。
//   node test/extension-live-check.mjs
// 环境变量：CHROME_BIN、DSH_BASE（默认 http://127.0.0.1:3080）。
import { createServer } from 'node:http'
import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3080'
const DEBUG_PORT = 9338
const CHROME = process.env.CHROME_BIN
  ?? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'].find(existsSync)

if (!CHROME) {
  console.log('skip: no Chrome/Chromium found (set CHROME_BIN to run this check)')
  process.exit(0)
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x')
  const file = pathname === '/fixture.html'
    ? join(here, 'fixtures/extract-page.html')
    : pathname === '/extract.js'
      ? join(root, 'extension/extract.js')
      : undefined
  if (!file) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' })
  res.end(await readFile(file))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const profile = await mkdtemp(join(tmpdir(), 'dsh-browser-tabs-'))
const extensionDir = join(root, 'extension')

const chrome = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--no-first-run',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  `http://127.0.0.1:${port}/fixture.html`,
], { stdio: 'ignore' })

let checks = 0
let failed = 0
const ok = (name, pass, detail = '') => {
  checks += 1
  if (pass) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const post = async (path) => {
  const response = await fetch(`${BASE}/dsh-browser-tabs/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'extension-live-check' }),
  })
  return response.json()
}

/** One browser-level CDP connection for target discovery and worker evaluation. */
async function openBrowserCdp() {
  const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
  const socket = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const resolver = pending.get(message.id)
    if (resolver) { pending.delete(message.id); resolver(message) }
  })
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { send, close: () => socket.close() }
}

/**
 * Chrome hides command-line extensions unless they actually started, and the
 * page-level /json/list keeps its own list. This looks at every service worker
 * target and asks its manifest who it is, so a bundled Chrome component can
 * never be mistaken for our extension.
 */
async function extensionLoaded() {
  try {
    const cdp = await openBrowserCdp()
    try {
      const answer = await cdp.send('Target.getTargets')
      const workers = (answer.result?.targetInfos ?? [])
        .filter((target) => String(target.url ?? '').includes('chrome-extension://') && String(target.url ?? '').includes('/background.js'))
      for (const worker of workers) {
        const attached = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })
        const sessionId = attached.result?.sessionId
        if (!sessionId) continue
        const evaluated = await cdp.send('Runtime.evaluate', {
          expression: 'chrome.runtime.getManifest().name',
          returnByValue: true,
          sessionId,
        })
        if (String(evaluated.result?.result?.value ?? '').includes('DSH Browser Tabs')) return true
      }
      return false
    } finally {
      cdp.close()
    }
  } catch {
    return false
  }
}

try {
  let loaded = false
  for (let attempt = 0; attempt < 20 && !loaded; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    loaded = await extensionLoaded()
  }

  if (!loaded) {
    console.log(`skip: this Chrome (${(await new Promise((resolve) => {
      const probe = spawn(CHROME, ['--version'])
      let out = ''
      probe.stdout.on('data', (chunk) => { out += chunk })
      probe.on('close', () => resolve(out.trim()))
    }))}) does not load command-line extensions`)
    console.log('  Google Chrome 158+ ignores --disable-extensions-except; use Chrome for Testing or load the extension in a normal Chrome window instead.')
    process.exitCode = 0
  } else {
    let firstSeen = 0
    let last = null
    for (let attempt = 0; attempt < 40 && firstSeen === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      try {
        last = await post('status')
        if (last?.online === true && last.lastSeen > 0) firstSeen = last.lastSeen
      } catch (error) {
        last = { error: String(error?.message ?? error) }
      }
    }
    ok('扩展自动连上 DSH', firstSeen > 0, JSON.stringify(last))

    let advanced = 0
    let latest = firstSeen
    for (let attempt = 0; attempt < 20 && advanced < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      const snapshot = await post('status')
      if (snapshot?.lastSeen > latest) { advanced += 1; latest = snapshot.lastSeen }
    }
    ok('轮询持续在跑', advanced >= 2, `lastSeen 前进 ${advanced} 次`)

    const empty = await post('poll')
    ok('空队列返回 []', Array.isArray(empty.requests) && empty.requests.length === 0, JSON.stringify(empty))
  }
} finally {
  const exited = new Promise((resolve) => chrome.once('exit', resolve))
  chrome.kill('SIGKILL')
  await exited
  server.close()
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(`\n${checks - failed}/${checks} passed`)
process.exit(failed === 0 ? 0 : 1)
