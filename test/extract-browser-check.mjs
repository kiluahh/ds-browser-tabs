// 真实浏览器里验证 extension/extract.js 的提取结果。
//
// 需要本机有 Chrome/Chromium；找不到就跳过并返回 0，主测试套件仍是纯 Node。
//   node test/extract-browser-check.mjs
import { createServer } from 'node:http'
import { readFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
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
const profile = await mkdtemp(join(tmpdir(), 'dsh-browser-tabs-extract-'))

try {
  const { stdout } = await run(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=4000',
    `--user-data-dir=${profile}`,
    '--dump-dom', `http://127.0.0.1:${port}/fixture.html`,
  ], { maxBuffer: 8 * 1024 * 1024 })
  const match = /<pre[^>]*id="receipt"[^>]*>([\s\S]*?)<\/pre>/u.exec(stdout)
  if (!match) { console.log('✗ 页面没有产出提取结果'); process.exit(1) }
  const decoded = match[1]
    .replace(/&quot;/gu, '"').replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&')
  const result = JSON.parse(decoded)
  const checks = [
    ['标题取自 document.title', result.title === '订单列表 · 测试'],
    ['URL 是页面地址', String(result.url).includes('/fixture.html')],
    ['包含 h1 文本', result.text.includes('订单列表')],
    ['包含段落', result.text.includes('共 3 笔订单。')],
    ['包含列表项', result.text.includes('#1001 已发货') && result.text.includes('#1003 已完成')],
    ['剔除 display:none', !result.text.includes('隐藏的 div')],
    ['剔除 visibility:hidden', !result.text.includes('visibility 隐藏')],
    ['剔除 aria-hidden', !result.text.includes('aria 隐藏')],
    ['剔除 script 内容', !result.text.includes('脚本内容不应出现')],
    ['保留可见 nav 文本', result.text.includes('订单中心')],
    ['保留可见 footer 文本', result.text.includes('客服电话')],
    ['保留 input 标签与值', result.text.includes('[input] 搜索订单: 1001')],
    ['保留 textarea 内容', result.text.includes('发货到前台')],
    ['保留图片替代文本', result.text.includes('[img] logo 图')],
    ['不含 canvas 占位垃圾', !/\[object/iu.test(result.text)],
    ['连续重复行只保留一次', (result.text.match(/重复的一行/gu) ?? []).length === 1],
    ['跳过空白 alt 的图片', !/\[img\]\s*\n/u.test(result.text) && (result.text.match(/\[img\]/gu) ?? []).length === 1],
  ]
  let failed = 0
  for (const [name, pass] of checks) {
    if (pass) console.log(`  ✓ ${name}`)
    else { failed += 1; console.log(`  ✗ ${name}`) }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
} finally {
  server.close()
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
