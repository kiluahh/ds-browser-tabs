import { MAX_TEXT_CHARS } from './meta.js'

export const EMPTY_TEXT_HINT = '页面当前没有可读文本（可能是纯 canvas / 图表页面）。'

/** Local ISO-like timestamp with an explicit offset, matching what the user sees. */
function localTimestamp(now) {
  const date = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  const minutes = -date.getTimezoneOffset()
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`
}

/**
 * Turn one extension payload into the rendered model-visible text plus a short
 * UI summary. Truncation and the empty-page hint live here so both the command
 * and the tools produce identical output.
 * @param {{ tab?: { id?: number, title?: string, url?: string }, text?: string,
 *   frames?: number, skippedFrames?: number }} payload
 * @param {{ now?: () => number, maxChars?: number }} [options]
 */
export function composeTabMessage(payload, options = {}) {
  const now = options.now ?? Date.now
  const maxChars = options.maxChars ?? MAX_TEXT_CHARS
  const tab = payload?.tab ?? {}
  const text = typeof payload?.text === 'string' ? payload.text : ''
  const label = tab.title?.trim() || tab.url?.trim() || `标签页 ${tab.id ?? '?'}`
  const empty = text.trim().length === 0
  const truncated = text.length > maxChars
  const body = truncated ? text.slice(0, maxChars) : text
  const skipped = Number(payload?.skippedFrames ?? 0)

  const lines = [
    `【浏览器标签页】${label}`,
    tab.url ? `URL: ${tab.url}` : undefined,
    `标签页: ${tab.id ?? '?'} · 采集于 ${localTimestamp(now())}`,
    skipped > 0 ? `另有 ${skipped} 个跨域框架无法读取` : undefined,
    '',
    empty ? EMPTY_TEXT_HINT : body,
    '',
    `【以上内容来自用户浏览器当前标签页的渲染结果，非 web_fetch 抓取${truncated ? '；正文已截断' : ''}】`,
  ].filter((line) => line !== undefined)

  return {
    rendered: lines.join('\n'),
    summary: `已把《${label}》投递给模型`,
    truncated,
    empty,
  }
}
