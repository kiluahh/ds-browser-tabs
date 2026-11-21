import { MAX_TEXT_CHARS } from './meta.js'
import { describeError } from './commands.js'

const OFFLINE_MESSAGE = 'no browser extension is connected; ask the user to enable it in chrome://extensions'

/** Render one tab payload as the same shape the `/browser` message uses. */
function renderText(payload, truncated) {
  const title = payload?.tab?.title || payload?.tab?.url || '标签页'
  const url = payload?.tab?.url ?? ''
  const body = String(payload?.text ?? '').slice(0, MAX_TEXT_CHARS)
  return `【${title}】${url}\n\n${body}${truncated ? '\n\n[正文已截断]' : ''}`
}

/**
 * One read-only tool so a follow-up "再看看那个标签页" does not force the user to
 * retype a command. It shares the command's request path and error text.
 */
export function registerTools(scope, deps) {
  const read = {
    name: 'browser_read',
    description: 'Read the rendered text of a tab the user already has open in Chrome. Use it only when the user refers to a page they are looking at; never browse on your own initiative.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute(_args = {}, execution) {
      const { bridge } = deps
      if (!bridge.online()) {
        return { ok: false, error: { code: 'offline', message: OFFLINE_MESSAGE } }
      }
      const payload = await bridge.request({ kind: 'read', signal: execution?.signal })
      if (payload.error) {
        return { ok: false, error: { code: payload.error.code, message: describeError(payload.error) } }
      }
      const truncated = payload.truncated === true || String(payload.text ?? '').length > MAX_TEXT_CHARS
      return { ok: true, value: { tab: payload.tab, text: String(payload.text ?? '').slice(0, MAX_TEXT_CHARS), truncated } }
    },
    output: {
      render: (_args, value) => [{ type: 'text', text: renderText(value, value?.truncated === true) }],
    },
  }

  for (const tool of [read]) {
    scope.effect(() => scope.tools.register(tool), `ds-browser-tabs: tool ${tool.name}`)
  }
}
