// 自检：node test/run.mjs。零依赖，纯 Node。
//
// 覆盖宿主半的全部纯逻辑：配置、请求队列、消息拼装、HTTP 端点、装配，
// 以及一次真实的「扩展轮询 → 回传 → 命令投递」端到端往返。
// 扩展本身（Chrome 侧）只做静态检查，实际提取与截图需要人工验证。

import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import {
  DEFAULT_ROUTE_PREFIX, DEFAULT_TIMEOUT_MS, MAX_TEXT_CHARS,
  normalizeRoutePrefix, resolveConfig,
} from '../lib/meta.js'
import { createBridge } from '../lib/bridge.js'
import { composeTabMessage, EMPTY_TEXT_HINT } from '../lib/compose.js'
import { createEndpoint } from '../lib/routes.js'
import { acceptKey, encodeFrame, createFrameParser } from '../lib/ws.js'
import { createTransport } from '../lib/transport.js'
import { createServer } from 'node:http'
import { createRouteHandler } from '../lib/server.js'
import { apply, createHostRuntime } from '../lib/host.js'
import { describeError } from '../lib/commands.js'

let passed = 0
let failed = 0
const section = (name) => console.log(`\n== ${name} ==`)
const ok = (name, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ---------------------------------------------------------------------------
section('meta')

ok('默认前缀', normalizeRoutePrefix(undefined) === DEFAULT_ROUTE_PREFIX)
ok('补前导斜杠', normalizeRoutePrefix('x/y') === '/x/y')
ok('去尾斜杠', normalizeRoutePrefix('/x/y/') === '/x/y')
ok('根路径保持', normalizeRoutePrefix('/') === '/')
ok('默认超时', resolveConfig().timeoutMs === DEFAULT_TIMEOUT_MS)
ok('超时非法回落默认', resolveConfig({ timeoutMs: -1 }).timeoutMs === DEFAULT_TIMEOUT_MS)
ok('超时可用字符串', resolveConfig({ timeoutMs: '2500' }).timeoutMs === 2500)
ok('令牌默认关闭', resolveConfig().token === '')
ok('正文上限 200k', MAX_TEXT_CHARS === 200_000)

// ---------------------------------------------------------------------------
section('bridge')

{
  const b = createBridge({ timeoutMs: 1000 })
  const p = b.request({ kind: 'read' })
  const [job] = b.poll()
  ok('request 带 id 与 kind', typeof job.id === 'string' && job.kind === 'read')
  ok('poll 后仍保留可结算', b.pending() === 1)
  ok('同一个请求不会被发两次', b.poll().length === 0)
  ok('poll 回报在线', b.online() === true)
  ok('settle 命中后 resolve', b.settle(job.id, { ok: true, data: { text: 'hi' } }) === true)
  ok('resolve 出结果', (await p).text === 'hi')
  ok('重复 settle 被拒', b.settle(job.id, { ok: true, data: { text: 'again' } }) === false)
}

{
  const b = createBridge({ timeoutMs: 30 })
  const p = b.request({ kind: 'read' })
  const [job] = b.poll()
  ok('超时报 timeout', (await p).error.code === 'timeout')
  ok('超时后队列清空', b.pending() === 0)
  ok('超时后 settle 被拒', b.settle(job.id, { ok: true, data: {} }) === false)
}

{
  // 从未被 poll 走的请求也要按时失败，且不留下定时器。
  const b = createBridge({ timeoutMs: 20 })
  const p = b.request({ kind: 'read' })
  ok('未取走时 pending 为 1', b.pending() === 1)
  ok('未取走也超时', (await p).error.code === 'timeout')
  ok('超时后队列清空', b.pending() === 0)
}

{
  const b = createBridge({ timeoutMs: 5000 })
  const p1 = b.request({ kind: 'read' })
  const [job1] = b.poll()
  const p2 = b.request({ kind: 'list' })
  const [job2] = b.poll()
  b.settle(job2.id, { ok: true, data: { tabs: [] } })
  b.settle(job1.id, { ok: true, data: { text: 'first' } })
  ok('乱序回包各自命中', (await p1).text === 'first' && Array.isArray((await p2).tabs))
}

{
  const b = createBridge({ timeoutMs: 5000 })
  const ac = new AbortController()
  const p = b.request({ kind: 'read', signal: ac.signal })
  const [job] = b.poll()
  ac.abort()
  ok('取消时报 aborted', (await p).error.code === 'aborted')
  ok('取消后 settle 被拒', b.settle(job.id, { ok: true, data: {} }) === false)
}

{
  const b = createBridge({ timeoutMs: 5000 })
  ok('从未 poll 时离线', b.online() === false)
  const p = b.request({ kind: 'read' })
  const [job] = b.poll()
  b.settle(job.id, { ok: false, error: { code: 'tab_closed', message: 'x' } })
  ok('失败回包透传错误码', (await p).error.code === 'tab_closed')
}

{
  const b = createBridge({ timeoutMs: 5000 })
  const started = Date.now()
  const empty = await b.poll({ waitMs: 40 })
  ok('长轮询到点返回空数组', Array.isArray(empty) && empty.length === 0 && Date.now() - started >= 30,
    `${Date.now() - started}ms`)
}

{
  const b = createBridge({ timeoutMs: 5000 })
  const waiting = b.poll({ waitMs: 2000 })
  ok('挂起的轮询算在线', b.online() === true && b.waiting() === 1)
  const p = b.request({ kind: 'read' })
  const jobs = await waiting
  ok('新请求立刻唤醒等待中的轮询', jobs.length === 1 && jobs[0].kind === 'read')
  ok('等待者被消费掉', b.waiting() === 0)
  b.settle(jobs[0].id, { ok: true, data: { text: 'x' } })
  ok('唤醒后仍能正常结算', (await p).text === 'x')
}

{
  const b = createBridge({ timeoutMs: 5000 })
  const ac = new AbortController()
  const waiting = b.poll({ waitMs: 2000, signal: ac.signal })
  ac.abort()
  ok('客户端断开时立即释放', (await waiting).length === 0 && b.waiting() === 0)
}

// ---------------------------------------------------------------------------
section('compose')

{
  const out = composeTabMessage({
    tab: { id: 7, title: '订单列表', url: 'https://example.com/orders' },
    text: '第一行\n第二行',
    frames: 2,
    skippedFrames: 0,
  }, { now: () => Date.parse('2026-11-21T13:10:32Z') })
  ok('带标题', out.rendered.includes('【浏览器标签页】订单列表'))
  ok('带 URL', out.rendered.includes('URL: https://example.com/orders'))
  ok('带标签页 id', out.rendered.includes('标签页: 7'))
  ok('正文原样保留换行', out.rendered.includes('第一行\n第二行'))
  ok('带来源说明', out.rendered.includes('非 web_fetch 抓取'))
  ok('未截断时不写截断说明', !out.rendered.includes('正文已截断'))
  ok('summary 不重复正文', !out.summary.includes('第一行'))
  ok('时间带时区偏移', /采集于 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/u.test(out.rendered))
}

{
  const big = 'a'.repeat(200_005)
  const out = composeTabMessage({ tab: { id: 1, title: '', url: '' }, text: big }, {})
  ok('超长正文截断', out.rendered.length < big.length + 2_000)
  ok('截断后置位', out.truncated === true)
  ok('写截断说明', out.rendered.includes('正文已截断'))
  ok('空标题回落 URL 或 id', out.rendered.includes('【浏览器标签页】标签页 1'))
}

{
  const out = composeTabMessage({ tab: { id: 2, title: '画板', url: 'https://x.test' }, text: '   \n  ' }, {})
  ok('空正文给提示', out.rendered.includes(EMPTY_TEXT_HINT))
  ok('空正文标记', out.empty === true)
}

{
  const out = composeTabMessage({ tab: { id: 3, title: 't', url: 'u' }, text: 'x', skippedFrames: 2 }, {})
  ok('标注跳过的跨域框架', out.rendered.includes('2 个跨域框架'))
}

// ---------------------------------------------------------------------------
section('routes')

function makeDeps(token = '') {
  const bridge = createBridge({ timeoutMs: 5000 })
  return { bridge, endpoint: createEndpoint({ bridge, config: { token } }) }
}

{
  const { endpoint } = makeDeps()
  const res = await endpoint.handle({ method: 'POST', pathname: '/poll', body: JSON.stringify({ clientId: 'c1' }) })
  ok('poll 200', res.status === 200)
  ok('poll 返回空队列', Array.isArray(res.body.requests) && res.body.requests.length === 0)
  ok('poll 带 CORS 头', res.headers['access-control-allow-origin'] === '*')
  ok('poll 带 no-store', res.headers['cache-control'] === 'no-store')
}

{
  const { endpoint } = makeDeps('secret')
  const res = await endpoint.handle({ method: 'POST', pathname: '/poll', body: JSON.stringify({ clientId: 'c1' }) })
  ok('错误令牌 401', res.status === 401)
  ok('401 不回显令牌', !JSON.stringify(res.body).includes('secret'))
  ok('401 错误码', res.body.error.code === 'unauthorized')
}

{
  const { bridge, endpoint } = makeDeps('t')
  const p = bridge.request({ kind: 'read' })
  const polled = await endpoint.handle({ method: 'POST', pathname: '/poll', body: JSON.stringify({ clientId: 'c1', token: 't' }) })
  const job = polled.body.requests[0]
  ok('正确令牌可取活', job.kind === 'read')
  const resultRes = await endpoint.handle({
    method: 'POST',
    pathname: '/result',
    body: JSON.stringify({ clientId: 'c1', token: 't', id: job.id, ok: true, data: { text: 'hello', tab: { id: 1 } } }),
  })
  ok('result 200', resultRes.status === 200)
  ok('result accepted', resultRes.body.accepted === true)
  ok('result 结算了请求', (await p).text === 'hello')
}

{
  const { endpoint } = makeDeps()
  const res = await endpoint.handle({ method: 'POST', pathname: '/result', body: JSON.stringify({ clientId: 'c1', id: 'nope', ok: true }) })
  ok('未知 id 不认领', res.body.accepted === false)
}

{
  const { endpoint } = makeDeps()
  ok('坏 JSON 400', (await endpoint.handle({ method: 'POST', pathname: '/poll', body: '{not json' })).status === 400)
  ok('空 body 当空对象', (await endpoint.handle({ method: 'POST', pathname: '/status', body: '' })).status === 200)
  ok('未知端点 404', (await endpoint.handle({ method: 'POST', pathname: '/nope', body: '{}' })).status === 404)
  ok('OPTIONS 204', (await endpoint.handle({ method: 'OPTIONS', pathname: '/poll', body: '' })).status === 204)
  ok('GET 405', (await endpoint.handle({ method: 'GET', pathname: '/poll', body: '' })).status === 405)
}

{
  const { endpoint } = makeDeps()
  const res = await endpoint.handle({ method: 'POST', pathname: '/status', body: JSON.stringify({ clientId: 'c1' }) })
  ok('status 在线判定可用', res.body.ok === true && res.body.online === false)
  ok('status 不泄漏 pending 内容', !('requests' in res.body))
}

{
  const { endpoint } = makeDeps()
  const started = Date.now()
  const res = await endpoint.handle({
    method: 'POST', pathname: '/poll', body: JSON.stringify({ clientId: 'c1', waitMs: 30 }),
  })
  ok('poll 接受 waitMs 并真的挂起', res.status === 200 && Date.now() - started >= 20)
  const status = await endpoint.handle({ method: 'POST', pathname: '/status', body: '{}' })
  ok('status 暴露等待数', typeof status.body.waiting === 'number')
}

section('websocket')

ok('accept-key 与 RFC 示例一致', acceptKey('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')

{
  const frame = encodeFrame(0x1, Buffer.from('hi'))
  ok('服务端帧不掩码、FIN 置位', frame[0] === 0x81 && frame[1] === 2)
  ok('短帧长度正确', frame.toString('utf8', 2) === 'hi')
}

{
  // 手工构造一个客户端掩码帧，验证解析器能还原内容。
  const payload = Buffer.from('{"a":1}')
  const mask = Buffer.from([1, 2, 3, 4])
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4]
  const header = Buffer.from([0x81, 0x80 | payload.length, ...mask])
  const frames = []
  const parse = createFrameParser((f) => frames.push(f))
  parse(Buffer.concat([header, masked]))
  ok('解析掩码文本帧', frames.length === 1 && frames[0].kind === 'text')
  ok('载荷还原正确', frames[0].payload.toString() === '{"a":1}')
}

{
  const frames = []
  const parse = createFrameParser((f) => frames.push(f))
  parse(Buffer.from([0x89, 0x00]))  // 无掩码 ping（测试用）
  ok('识别 ping 帧', frames[0]?.kind === 'ping')
}

{
  // 真实 HTTP 升级 + Node 自带 WebSocket 客户端，跑通握手、推送、回包、保活。
  const bridge = createBridge({ timeoutMs: 5000, onlineWindowMs: 50 })
  const transport = createTransport({ bridge, config: { token: '' }, flushEveryMs: 20, pingEveryMs: 80 })
  const server = createServer((_req, res) => res.end('ok'))
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/dsh-browser-tabs/ws') { socket.destroy(); return }
    transport.handleUpgrade(req, socket, head)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const seen = []
  const socket = new WebSocket(`ws://127.0.0.1:${port}/dsh-browser-tabs/ws`)
  socket.addEventListener('message', (event) => seen.push(JSON.parse(event.data)))
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.send(JSON.stringify({ type: 'hello', clientId: 'c1' }))

  const until = async (predicate, timeoutMs = 2000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return false
  }

  ok('握手后收到 welcome', await until(() => seen.some((m) => m.type === 'welcome')))
  ok('WS 连接算在线', bridge.online() === true)

  const pending = bridge.request({ kind: 'read' })
  ok('任务经 WS 推送', await until(() => seen.some((m) => m.type === 'job')))
  const job = seen.find((m) => m.type === 'job')
  socket.send(JSON.stringify({ type: 'result', id: job.id, ok: true, data: { text: 'ws' } }))
  ok('WS 回包结算请求', (await pending).text === 'ws')
  ok('应用层 ping 保活', await until(() => seen.some((m) => m.type === 'ping'), 1000))
  socket.send(JSON.stringify({ type: 'pong' }))

  socket.close()
  ok('断开后不再算在线', await until(() => bridge.online() === false, 1500))
  transport.dispose()
  server.close()
}

{
  // 两个浏览器同时连接时，任务必须发给"开着 DSH"的那个
  const bridge = createBridge({ timeoutMs: 5000, onlineWindowMs: 50 })
  const transport = createTransport({ bridge, config: { token: '' }, flushEveryMs: 20, pingEveryMs: 5_000 })
  const server = createServer((_req, res) => res.end('ok'))
  server.on('upgrade', (req, socket, head) => transport.handleUpgrade(req, socket, head))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = `ws://127.0.0.1:${port}/dsh-browser-tabs/ws`

  const connect = async (hello) => {
    const seen = []
    const socket = new WebSocket(url)
    socket.addEventListener('message', (event) => seen.push(JSON.parse(event.data)))
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', ...hello })))
    await new Promise((resolve) => setTimeout(resolve, 100))
    return { socket, seen }
  }

  // 两个浏览器都开着 DSH，只有 Chrome 的窗口是聚焦的
  const firefox = await connect({ clientId: 'ff', browser: 'Firefox', hasDsh: true, dshFocused: false })
  const chrome = await connect({ clientId: 'cr', browser: 'Chrome', hasDsh: true, dshFocused: true })

  const pending = bridge.request({ kind: 'list' })
  const until = async (predicate, timeoutMs = 1500) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return false
  }
  ok('任务投给 DSH 正在使用的浏览器', await until(() => chrome.seen.some((m) => m.type === 'job')))
  ok('另一个浏览器不会收到任务', !firefox.seen.some((m) => m.type === 'job'))
  const job = chrome.seen.find((m) => m.type === 'job')
  chrome.socket.send(JSON.stringify({ type: 'result', id: job.id, ok: true, data: { browser: 'Chrome', tabs: [] } }))
  ok('结果照常结算', (await pending).browser === 'Chrome')

  // 焦点切到 Firefox 后，后续任务必须改投 Firefox（即使 Chrome 更新）
  chrome.socket.send(JSON.stringify({ type: 'state', hasDsh: true, dshFocused: false }))
  firefox.socket.send(JSON.stringify({ type: 'state', hasDsh: true, dshFocused: true }))
  await new Promise((resolve) => setTimeout(resolve, 80))
  const second = bridge.request({ kind: 'list' })
  ok('焦点切换后任务改投 Firefox', await until(() => firefox.seen.some((m) => m.type === 'job')))
  const secondJob = firefox.seen.find((m) => m.type === 'job')
  firefox.socket.send(JSON.stringify({ type: 'result', id: secondJob.id, ok: true, data: { browser: 'Firefox', tabs: [] } }))
  ok('第二次结果也结算', (await second).browser === 'Firefox')

  firefox.socket.close()
  chrome.socket.close()
  transport.dispose()
  server.close()
}

// ---------------------------------------------------------------------------
section('host assembly')

function hostHarness(config = {}) {
  const routes = []
  const tools = []
  const commands = []
  const effect = (fn) => { const dispose = fn(); return () => dispose?.() }
  const ctx = {
    effect,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    inject: (deps, cb) => {
      const scope = { effect }
      if (deps.includes('workingDirectory')) scope.workingDirectory = { get: (session) => session?.cwd }
      if (deps.includes('webServer')) scope.webServer = {
        register: (r) => { routes.push(r); return () => {} },
        registerUpgrade: (r) => { routes.push(r); return () => {} },
      }
      if (deps.includes('tools')) scope.tools = { register: (t) => { tools.push(t); return () => {} } }
      cb(scope)
    },
    commands: { register: (definition) => { commands.push(definition); return () => {} } },
  }
  const runtime = apply(ctx, config)
  return { routes, tools, commands, runtime }
}

/** Drive the real route handler with a fake Node req/res pair. */
async function callHttp(handler, pathname, body) {
  const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  req.method = 'POST'
  req.url = pathname
  let status = 0
  let headers = {}
  let payload = ''
  const res = {
    headersSent: false,
    on() {},
    writeHead(code, hdrs) { status = code; headers = hdrs; this.headersSent = true },
    end(chunk) { payload = chunk === undefined ? '' : String(chunk) },
  }
  await handler(req, res)
  return { status, headers, body: payload.length === 0 ? null : JSON.parse(payload) }
}

{
  const h = hostHarness({ token: '' })
  ok('注册了 /browser 命令', h.commands.some((c) => c.name === 'browser'))
  const demo = h.commands[0]
  ok('命令有 description 与 input hint', demo.description.length > 0 && demo.input.hint.length > 0)
  ok('注册了 webServer 前缀路由', h.routes.filter((r) => r.kind === 'prefix').length === 1)
  ok('注册了 WebSocket 升级路由', h.routes.some((r) => r.path === '/dsh-browser-tabs/ws'))
  ok('路由前缀对', h.routes[0].path === DEFAULT_ROUTE_PREFIX)
  ok('只注册了 browser_read 工具', h.tools.length === 1)
  ok('工具名对', h.tools.map((t) => t.name).join(',') === 'browser_read')
  ok('工具只读：没有必填参数', h.tools.every((t) => (t.parameters.required ?? []).length === 0))
  ok('自定义路由前缀生效', hostHarness({ routePrefix: '/x' }).routes[0].path === '/x')
}

{
  const h = hostHarness({ token: '' })
  const demo = h.commands.find((c) => c.name === 'browser')
  const result = await demo.handler({
    agent: { id: 's', followup: () => { throw new Error('must not wake when offline') } },
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  })
  ok('离线时命令失败', result.kind === 'error')
  ok('离线时给出安装提示', result.text.includes('chrome://extensions'))
  ok('离线时说明从未连接', result.text.includes('从未连接'))
}

{
  // 端到端：首次轮询让扩展上线 → /browser 投递 + 唤醒
  const h = hostHarness({ token: '' })
  const route = h.routes[0].handler
  await callHttp(route, '/poll', { clientId: 'c1' })
  const demo = h.commands.find((c) => c.name === 'browser')

  const woken = []
  const agent = { id: 's', followup: (msg) => woken.push(msg) }
  const pending = demo.handler({ agent, rawInput: '', attachments: [], signal: new AbortController().signal })

  // 扩展取活
  const polled = await callHttp(route, '/poll', { clientId: 'c1' })
  const job = polled.body.requests[0]
  ok('命令登记了 read 请求', job.kind === 'read')
  ok('不带序号时不指定 tabId（由扩展选第一个非 DSH 页）', job.tabId === undefined)
  await callHttp(route, '/result', {
    clientId: 'c1',
    id: job.id,
    ok: true,
    data: { tab: { id: 9, title: '订单列表', url: 'https://example.com/orders' }, text: '第一行' },
  })

  const result = await pending
  ok('命令成功', result.kind === 'success')
  ok('UI 回执提到标题', result.text.includes('订单列表'))
  ok('唤醒恰好一次', woken.length === 1)
  ok('投递的是 user 消息', woken[0]?.role === 'user')
  ok('消息来源是 browser-tab', woken[0]?.source?.kind === 'browser-tab')
  ok('消息里有正文', woken[0]?.content?.[0]?.text?.includes('第一行') === true)
  ok('消息 id 是 uuid', /^[0-9a-f-]{36}$/u.test(woken[0]?.id ?? ''))
}

{
  // /browser list 只出 UI，不唤醒
  const h = hostHarness({ token: '' })
  const route = h.routes[0].handler
  await callHttp(route, '/poll', { clientId: 'c1' })
  const demo = h.commands.find((c) => c.name === 'browser')
  const woken = []
  const pending = demo.handler({
    agent: { id: 's', followup: (msg) => woken.push(msg) },
    rawInput: 'list',
    attachments: [],
    signal: new AbortController().signal,
  })
  const polled = await callHttp(route, '/poll', { clientId: 'c1' })
  const job = polled.body.requests[0]
  ok('list 登记的是 list 请求', job.kind === 'list')
  await callHttp(route, '/result', {
    clientId: 'c1',
    id: job.id,
    ok: true,
    data: { tabs: [{ id: 1, title: 'A', url: 'https://a.test', active: true }, { id: 2, title: 'B', url: 'https://b.test', active: false }] },
  })
  const result = await pending
  ok('list 成功', result.kind === 'success')
  ok('list 用序号并标出活动页', result.text.includes('1. ★'))
  ok('list 提示用序号读取', result.text.includes('/browser <序号>'))
  ok('list 不唤醒模型', woken.length === 0)
}

{
  // /browser <关键字> 唯一命中
  const h = hostHarness({ token: '' })
  const route = h.routes[0].handler
  await callHttp(route, '/poll', { clientId: 'c1' })
  const demo = h.commands.find((c) => c.name === 'browser')
  const woken = []
  const pending = demo.handler({
    agent: { id: 's', followup: (msg) => woken.push(msg) },
    rawInput: 'docs',
    attachments: [],
    signal: new AbortController().signal,
  })
  const first = (await callHttp(route, '/poll', { clientId: 'c1' })).body.requests[0]
  await callHttp(route, '/result', {
    clientId: 'c1',
    id: first.id,
    ok: true,
    data: { tabs: [{ id: 5, title: 'Docs home', url: 'https://docs.test', active: false }] },
  })
  const second = (await callHttp(route, '/poll', { clientId: 'c1' })).body.requests[0]
  ok('关键字先查列表再读页', first.kind === 'list' && second.kind === 'read')
  ok('读的是命中的标签页', second.tabId === 5)
  await callHttp(route, '/result', {
    clientId: 'c1',
    id: second.id,
    ok: true,
    data: { tab: { id: 5, title: 'Docs home', url: 'https://docs.test' }, text: 'docs body' },
  })
  const result = await pending
  ok('关键字命中后投递', result.kind === 'success' && woken.length === 1)
}

{
  // /browser <关键字> 无命中
  const h = hostHarness({ token: '' })
  const route = h.routes[0].handler
  await callHttp(route, '/poll', { clientId: 'c1' })
  const demo = h.commands.find((c) => c.name === 'browser')
  const pending = demo.handler({
    agent: { id: 's', followup: () => { throw new Error('must not wake') } },
    rawInput: 'zzz',
    attachments: [],
    signal: new AbortController().signal,
  })
  const first = (await callHttp(route, '/poll', { clientId: 'c1' })).body.requests[0]
  await callHttp(route, '/result', {
    clientId: 'c1',
    id: first.id,
    ok: true,
    data: { tabs: [{ id: 5, title: 'Docs home', url: 'https://docs.test', active: false }] },
  })
  const result = await pending
  ok('无命中报错', result.kind === 'error')
  ok('无命中列出关键字', result.text.includes('zzz'))
}

{
  // 扩展在线但超时
  const h = hostHarness({ token: '', timeoutMs: 40 })
  const route = h.routes[0].handler
  await callHttp(route, '/poll', { clientId: 'c1' })
  const demo = h.commands.find((c) => c.name === 'browser')
  const pending = demo.handler({
    agent: { id: 's', followup: () => { throw new Error('must not wake') } },
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  })
  await callHttp(route, '/poll', { clientId: 'c1' })
  const result = await pending
  ok('超时报错而不是挂住', result.kind === 'error' && result.text.includes('8 秒'))
}

{
  // 标签页在请求中关闭
  const h = hostHarness({ token: '' })
  const route = h.routes[0].handler
  await callHttp(route, '/poll', { clientId: 'c1' })
  const demo = h.commands.find((c) => c.name === 'browser')
  const pending = demo.handler({
    agent: { id: 's', followup: () => { throw new Error('must not wake') } },
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  })
  const job = (await callHttp(route, '/poll', { clientId: 'c1' })).body.requests[0]
  await callHttp(route, '/result', { clientId: 'c1', id: job.id, ok: false, error: { code: 'tab_closed', message: 'gone' } })
  const result = await pending
  ok('标签页关闭有专门文案', result.kind === 'error' && result.text.includes('已关闭'))
}

{
  // 扩展在线但迟迟不取活 → 超时文案要能指向"点图标唤醒"
  const h = hostHarness({ token: '', timeoutMs: 30 })
  const route = h.routes[0].handler
  await callHttp(route, '/poll', { clientId: 'c1' })
  const demo = h.commands.find((c) => c.name === 'browser')
  const pending = demo.handler({
    agent: { id: 's', followup: () => { throw new Error('must not wake') } },
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  })
  await callHttp(route, '/poll', { clientId: 'c1' })
  const result = await pending
  ok('超时提示唤醒图标', result.kind === 'error' && result.text.includes('扩展图标'))
}

{
  // /browser status 只出 UI
  const h = hostHarness({ token: '' })
  const demo = h.commands.find((c) => c.name === 'browser')
  const woken = []
  const result = await demo.handler({
    agent: { id: 's', followup: (m) => woken.push(m) },
    rawInput: 'status',
    attachments: [],
    signal: new AbortController().signal,
  })
  ok('/browser status 成功', result.kind === 'success')
  ok('status 给出在线状态', result.text.includes('扩展在线：否'))
  ok('status 给出连接数', result.text.includes('WebSocket 连接：0'))
  ok('status 不唤醒模型', woken.length === 0)
}

{
  // /browser 2 按 list 里的序号选
  const h = hostHarness({ token: '' })
  const route = h.routes[0].handler
  await callHttp(route, '/poll', { clientId: 'c1' })
  const demo = h.commands.find((c) => c.name === 'browser')
  const woken = []
  const pending = demo.handler({
    agent: { id: 's', followup: (m) => woken.push(m) },
    rawInput: '2',
    attachments: [],
    signal: new AbortController().signal,
  })
  const listed = (await callHttp(route, '/poll', { clientId: 'c1' })).body.requests[0]
  ok('序号先查列表', listed.kind === 'list')
  await callHttp(route, '/result', {
    clientId: 'c1',
    id: listed.id,
    ok: true,
    data: { tabs: [{ id: 7, title: 'A', url: 'https://a.test' }, { id: 9, title: 'B', url: 'https://b.test' }] },
  })
  const read = (await callHttp(route, '/poll', { clientId: 'c1' })).body.requests[0]
  ok('序号 2 选中第二个标签页', read.kind === 'read' && read.tabId === 9)
  await callHttp(route, '/result', {
    clientId: 'c1', id: read.id, ok: true, data: { tab: { id: 9, title: 'B', url: 'https://b.test' }, text: 'B 的正文' },
  })
  ok('序号命中后投递', (await pending).kind === 'success' && woken.length === 1)
}

{
  // 序号越界
  const h = hostHarness({ token: '' })
  const route = h.routes[0].handler
  await callHttp(route, '/poll', { clientId: 'c1' })
  const demo = h.commands.find((c) => c.name === 'browser')
  const pending = demo.handler({
    agent: { id: 's', followup: () => { throw new Error('must not wake') } },
    rawInput: '5',
    attachments: [],
    signal: new AbortController().signal,
  })
  const listed = (await callHttp(route, '/poll', { clientId: 'c1' })).body.requests[0]
  await callHttp(route, '/result', {
    clientId: 'c1', id: listed.id, ok: true, data: { tabs: [{ id: 7, title: 'A', url: 'https://a.test' }] },
  })
  const result = await pending
  ok('越界序号报错', result.kind === 'error' && result.text.includes('1–1'))
}

// ---------------------------------------------------------------------------
section('error mapping')

const codes = ['timeout', 'aborted', 'tab_closed', 'inject_denied', 'not_active', 'unauthorized', 'weird']
for (const code of codes) {
  const text = describeError({ code, message: 'm' })
  ok(`错误码 ${code} 有可读文案`, typeof text === 'string' && text.length > 0 && !text.includes('undefined'))
}

// ---------------------------------------------------------------------------
section('extension (static)')

const EXT = new URL('../extension/', import.meta.url)
ok('manifest 存在', existsSync(new URL('manifest.json', EXT)))
const manifest = JSON.parse(readFileSync(new URL('manifest.json', EXT), 'utf8'))
ok('MV3', manifest.manifest_version === 3)
ok('有 background service worker', manifest.background?.service_worker === 'background.js')
ok('申请了 scripting 权限', manifest.permissions.includes('scripting'))
ok('申请了 alarms 兜底唤醒', manifest.permissions.includes('alarms'))
ok('允许注入所有站点', manifest.host_permissions.includes('<all_urls>'))
ok('只回连回环地址', manifest.host_permissions.includes('http://127.0.0.1/*'))
ok('有 popup', manifest.action?.default_popup === 'popup.html')
ok('CSP 放行回环 http/ws', String(manifest.content_security_policy?.extension_pages ?? '').includes('ws://127.0.0.1:*'))
for (const file of ['background.js', 'extract.js', 'popup.js', 'popup.html', 'popup.css', 'icon.png']) {
  ok(`${file} 存在`, existsSync(new URL(file, EXT)))
}
ok('background 引用 extract', readFileSync(new URL('background.js', EXT), 'utf8').includes("from './extract.js'"))

section('extension (cross-browser)')

const backgroundText = readFileSync(new URL('background.js', EXT), 'utf8')
const popupText = readFileSync(new URL('popup.js', EXT), 'utf8')
ok('background 使用 browser/chrome shim', backgroundText.includes('globalThis.browser ?? globalThis.chrome'))
ok('popup 使用同一 shim', popupText.includes('globalThis.browser ?? globalThis.chrome'))
ok('background 不再硬编码 chrome.*',
  !/\bchrome\.(storage|tabs|scripting|runtime|alarms)\b/u.test(backgroundText))
ok('popup 不再硬编码 chrome.*',
  !/\bchrome\.(storage|runtime)\b/u.test(popupText))
ok('不指定执行世界（两个浏览器默认都可用）', !backgroundText.includes("world: 'MAIN'"))
ok('闹钟 1 分钟（Firefox 的下限，Chrome 也接受）', backgroundText.includes('periodInMinutes: 1'))
ok('scripting 不可用时有明确报错', backgroundText.includes("this browser does not expose scripting.executeScript"))
ok('用长轮询保持 worker 存活', backgroundText.includes('waitMs: POLL_HOLD_MS'))
ok('looping 有声明（防 ReferenceError）', backgroundText.includes('let looping = false'))
ok('hello 在捕获的 socket 上发送', backgroundText.includes('const ws = new WebSocket(url)') && backgroundText.includes('ws.readyState !== 1'))
ok('hello 不依赖全局 socket 变量', !backgroundText.includes('socket?.send(JSON.stringify({\n          type: \'hello\''))
ok('不再靠 setInterval 轮询', !backgroundText.includes('setInterval('))

section('firefox build')

const build = spawnSync(process.execPath, [new URL('../scripts/build-firefox.mjs', import.meta.url).pathname], {
  encoding: 'utf8',
  timeout: 60_000,
})
ok('构建脚本成功', build.status === 0, (build.stderr ?? '').slice(-200))
const ffManifestPath = new URL('../dist/firefox/manifest.json', import.meta.url)
ok('dist/firefox/manifest.json 存在', existsSync(ffManifestPath))
const ffManifest = JSON.parse(readFileSync(ffManifestPath, 'utf8'))
ok('Firefox 用 event page 而不是 service worker',
  Array.isArray(ffManifest.background?.scripts) && ffManifest.background.service_worker === undefined)
ok('Firefox 模块化 event page', ffManifest.background?.type === 'module')
ok('Firefox 带 gecko id', ffManifest.browser_specific_settings?.gecko?.id === 'ds-browser-tabs@local')
ok('Firefox 保留同样权限', ffManifest.permissions.join(',') === manifest.permissions.join(','))
ok('Firefox 保留 <all_urls>', ffManifest.host_permissions.includes('<all_urls>'))
ok('Firefox 显式允许 ws 回环', ffManifest.host_permissions.includes('ws://127.0.0.1/*'))
ok('Firefox 保留 CSP', String(ffManifest.content_security_policy?.extension_pages ?? '').includes('connect-src'))
const xpiPath = new URL('../dist/ds-browser-tabs-firefox.xpi', import.meta.url)
ok('xpi 存在', existsSync(xpiPath))
const xpi = readFileSync(xpiPath)
ok('xpi 是合法 zip（PK 头）', xpi[0] === 0x50 && xpi[1] === 0x4b && xpi[2] === 0x03 && xpi[3] === 0x04)
ok('xpi 含 manifest.json', xpi.includes(Buffer.from('manifest.json')) && xpi.includes(Buffer.from('background.js')))

// ---------------------------------------------------------------------------
section('extension (real browser, optional)')

// 提取函数的真实渲染验证需要 Chrome；没有就跳过，主套件保持纯 Node。
const browserCheck = spawnSync(process.execPath, [new URL('extract-browser-check.mjs', import.meta.url).pathname], {
  encoding: 'utf8',
  timeout: 120_000,
})
if (browserCheck.status === 0) {
  const summary = (browserCheck.stdout ?? '').trim().split('\n').at(-1) ?? ''
  ok(`真实浏览器提取验证（${summary}）`, true)
} else if ((browserCheck.stdout ?? '').includes('skip: no Chrome')) {
  console.log('  … 跳过：本机没有 Chrome/Chromium')
} else {
  ok('真实浏览器提取验证', false, (browserCheck.stdout ?? browserCheck.stderr ?? '').slice(-400))
}

// ---------------------------------------------------------------------------
section('extension (live wire, optional)')

const liveCheck = spawnSync(process.execPath, [new URL('extension-live-check.mjs', import.meta.url).pathname], {
  encoding: 'utf8',
  timeout: 180_000,
})
const liveOut = liveCheck.stdout ?? ''
if (liveCheck.status === 0 && /^skip:/mu.test(liveOut.trim())) {
  console.log(`  … ${liveOut.trim().split('\n')[0]}`)
} else {
  const lastLine = liveOut.trim().split('\n').at(-1) ?? ''
  ok(`扩展与 DSH 的实时链路（${lastLine}）`, liveCheck.status === 0, liveOut.trim().slice(-300))
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
