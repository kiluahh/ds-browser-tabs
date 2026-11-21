import { randomUUID } from 'node:crypto'
import { composeTabMessage } from './compose.js'

const OFFLINE_HINT = '未检测到浏览器扩展。请在 chrome://extensions 确认 DSH Browser Tabs 已启用，并打开扩展弹窗确认地址已填写。如果扩展已安装：点一下工具栏上的扩展图标唤醒它，再重试。'
const RECENT_MS = 90_000
const SHOT_DIR = 'browser-tabs'

/** One user-visible failure with a next step. */
function failure(text) {
  return { kind: 'error', text }
}

/**
 * Map an extension error code to an actionable sentence. Every code the
 * extension / bridge can produce has a branch here.
 */
export function describeError(error) {
  switch (error?.code) {
    case 'timeout':
      return '已登记读取请求，但扩展 8 秒内没有响应。点一下 Chrome 工具栏上的扩展图标唤醒它；仍不行就确认扩展弹窗里的地址与 DSH 实际端口一致。'
    case 'aborted':
      return '读取已取消。'
    case 'tab_closed':
      return '该标签页已关闭，请重新查看目标页。'
    case 'inject_denied':
      return '该页面不允许扩展注入（可能是浏览器内置页或受保护页面）。'
    case 'not_active':
      return '只能截取当前窗口的活动标签页，请先切到目标页。'
    case 'unauthorized':
      return '扩展令牌与 DSH 配置不一致，请在扩展弹窗里重新填写。'
    default:
      return `读取失败：${error?.message ?? error?.code ?? '未知错误'}`
  }
}

/** Ask the extension for the visible tabs; `/browser list` and keyword lookup share it. */
async function listTabs(deps, signal) {
  const payload = await deps.bridge.request({ kind: 'list', signal })
  if (payload.error) return { error: payload.error }
  return {
    tabs: Array.isArray(payload.tabs) ? payload.tabs : [],
    browser: typeof payload.browser === 'string' ? payload.browser : undefined,
  }
}

/** Resolve `/browser <keyword>` to exactly one tab, or explain the candidates. */
function matchTabs(tabs, keyword) {
  const needle = keyword.toLowerCase()
  const hits = tabs.filter((tab) =>
    String(tab.title ?? '').toLowerCase().includes(needle)
    || String(tab.url ?? '').toLowerCase().includes(needle))
  if (hits.length === 1) return { tab: hits[0] }
  if (hits.length === 0) return { error: `没有标题或 URL 包含 “${keyword}” 的标签页` }
  const shown = hits.slice(0, 8).map((tab) => `  ${tab.id} · ${tab.title || tab.url}`).join('\n')
  return { error: `“${keyword}” 匹配到 ${hits.length} 个标签页，请写得更具体：\n${shown}` }
}

/** Render `/browser list`, numbered so `/browser <序号>` works. */
function renderTabList(tabs, browser) {
  const header = browser === undefined ? '' : `浏览器：${browser}\n`
  if (tabs.length === 0) return `${header}当前没有可读的标签页。`
  return `${header}${tabs
    .map((tab, index) => `${index + 1}. ${tab.active ? '★ ' : ''}${tab.title || '(无标题)'}\n    ${tab.url}`)
    .join('\n')}\n\n用 /browser <序号> 读取其中一个。`
}

/**
 * Register `/browser` and its argument forms. Success both returns a short UI
 * receipt and wakes the model with the rendered page content, because command
 * results never reach the model context by themselves.
 */
export function registerCommands(ctx, deps) {
  return ctx.commands.register({
    name: 'browser',
    description: '读取用户浏览器里某个标签页已渲染的内容（默认第一个可读标签页）',
    input: { hint: '[<序号>|list|<关键字>|status]' },
    handler: async (invocation) => {
      const { bridge } = deps
      const raw = String(invocation.rawInput ?? '').trim()
      const signal = invocation.signal

      if (raw === 'status') {
        const stats = deps.stats?.() ?? {}
        const seen = stats.lastSeen > 0 ? new Date(stats.lastSeen).toLocaleString() : '从未连接'
        return {
          kind: 'success',
          text: [
            `扩展在线：${stats.online ? '是' : '否'}`,
            `WebSocket 连接：${stats.connections ?? 0}`,
            ...(stats.browsers ?? []).map((row) => `已连接浏览器：${row.browser}${row.dshFocused ? '（DSH 正在这里使用）' : row.hasDsh ? '（DSH 开在这里，但未聚焦）' : ''}`),
            `挂起的轮询：${stats.waiting ?? 0}`,
            `等待中的请求：${stats.pending ?? 0}`,
            `最后在线：${seen}`,
          ].join('\n'),
        }
      }

      if (!bridge.online()) {
        const seen = bridge.lastSeen()
        if (seen > 0 && Date.now() - seen < RECENT_MS) {
          const seconds = Math.round((Date.now() - seen) / 1_000)
          return failure(`浏览器扩展正在休眠（最后在线 ${seconds} 秒前）。点一下 Chrome 工具栏上的 DSH Browser Tabs 图标唤醒它，再重试 /browser。`)
        }
        const when = seen > 0 ? `最后在线：${new Date(seen).toLocaleString()}` : '从未连接'
        return failure(`${OFFLINE_HINT}\n${when}`)
      }

      if (raw === 'list') {
        const listed = await listTabs(deps, signal)
        if (listed.error) return failure(describeError(listed.error))
        return { kind: 'success', text: renderTabList(listed.tabs, listed.browser) }
      }

      let tabId
      if (raw.length > 0 && /^\d+$/u.test(raw)) {
        // A bare number is a position in `/browser list`, not a tab id.
        const index = Number(raw) - 1
        const listed = await listTabs(deps, signal)
        if (listed.error) return failure(describeError(listed.error))
        if (index < 0 || index >= listed.tabs.length) {
          return failure(`只有 ${listed.tabs.length} 个可读标签页，请输入 1–${listed.tabs.length}。`)
        }
        tabId = listed.tabs[index].id
      } else if (raw.length > 0) {
        const listed = await listTabs(deps, signal)
        if (listed.error) return failure(describeError(listed.error))
        const matched = matchTabs(listed.tabs, raw)
        if (matched.error) return failure(matched.error)
        tabId = matched.tab.id
      }

      const payload = await bridge.request({ kind: 'read', tabId, signal })
      if (payload.error) return failure(describeError(payload.error))
      const composed = composeTabMessage(payload)
      invocation.agent.followup({
        id: randomUUID(),
        role: 'user',
        source: { kind: 'browser-tab' },
        content: [{ type: 'text', text: composed.rendered }],
      })
      return { kind: 'success', text: `${composed.summary}，模型已开始分析。` }
    },
  })
}
