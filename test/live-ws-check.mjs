// 对着**正在运行**的 DSH 验证 WebSocket 通道（宿主侧），不需要浏览器扩展。
//
//   node test/live-ws-check.mjs
//
// 它做的事和扩展一模一样：连上 /dsh-browser-tabs/ws、发 hello、等 welcome，
// 然后看 /status 是否把这条连接算作在线。

const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3080'
const WS_URL = `${BASE.replace(/^http/u, 'ws')}/dsh-browser-tabs/ws`

if (typeof WebSocket !== 'function') {
  console.log('skip: this Node has no global WebSocket (need Node 22+)')
  process.exit(0)
}

let checks = 0
let failed = 0
const ok = (name, pass, detail = '') => {
  checks += 1
  if (pass) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const status = async () => {
  const response = await fetch(`${BASE}/dsh-browser-tabs/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  return response.json()
}

const before = await status().catch(() => undefined)
ok('HTTP 端点可达', before !== undefined && before.ok === true, JSON.stringify(before))
ok('运行的是新版宿主（status 带 waiting）', before?.waiting !== undefined,
  before?.waiting === undefined ? '请先重启 DSH，让宿主半体加载新代码' : `waiting=${before.waiting}`)

const socket = new WebSocket(WS_URL)
const messages = []
socket.addEventListener('message', (event) => messages.push(JSON.parse(event.data)))

const until = async (predicate, timeoutMs = 3000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

const opened = await new Promise((resolve) => {
  socket.addEventListener('open', () => resolve(true), { once: true })
  socket.addEventListener('error', () => resolve(false), { once: true })
})
ok('WebSocket 升级成功（101）', opened)

if (opened) {
  socket.send(JSON.stringify({ type: 'hello', clientId: 'live-ws-check' }))
  ok('收到 welcome', await until(() => messages.some((m) => m.type === 'welcome')), JSON.stringify(messages[0] ?? null))

  const after = await status().catch(() => undefined)
  ok('WS 连接被算作在线', after?.online === true, JSON.stringify(after))

  ok('保活 ping 会到达', await until(() => messages.some((m) => m.type === 'ping'), 25_000))
  socket.close()
}

console.log(`\n${checks - failed}/${checks} passed`)
if (failed > 0) process.exitCode = 1
