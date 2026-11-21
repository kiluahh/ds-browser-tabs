import { MAX_POLL_HOLD_MS } from './meta.js'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'cache-control': 'no-store',
}

/** One endpoint result: status, JSON body, and the headers the extension origin needs. */
function json(status, body) {
  return { status, headers: JSON_HEADERS, body }
}

/** Accept the last path segment as the endpoint name. */
function endpointOf(pathname) {
  return pathname.split('/').filter(Boolean).at(-1) ?? ''
}

/**
 * Pure HTTP-shaped logic for the extension endpoints. It takes plain
 * `{ method, pathname, body }` so it can be unit-tested without sockets, and
 * returns `{ status, headers, body }` so the Node adapter stays trivial.
 * @param {{ bridge: ReturnType<typeof import('./bridge.js').createBridge>, config: { token?: string } }} deps
 */
export function createEndpoint({ bridge, config }) {
  const token = config?.token ?? ''
  const authorized = (parsed) => token.length === 0
    || (typeof parsed?.token === 'string' && parsed.token === token)

  async function handle({ method, pathname, body, signal }) {
    if (method === 'OPTIONS') return { status: 204, headers: JSON_HEADERS, body: null }
    if (method !== 'POST') return json(405, { ok: false, error: { code: 'method_not_allowed' } })

    let parsed
    try {
      parsed = JSON.parse(body === undefined || body === '' ? '{}' : body)
    } catch {
      return json(400, { ok: false, error: { code: 'bad_json' } })
    }
    if (!authorized(parsed)) return json(401, { ok: false, error: { code: 'unauthorized' } })

    switch (endpointOf(pathname)) {
      case 'poll': {
        const waitMs = Math.min(Math.max(Number(parsed.waitMs ?? 0) || 0, 0), MAX_POLL_HOLD_MS)
        const requests = await bridge.poll({ waitMs, signal })
        return json(200, { ok: true, online: true, requests })
      }
      case 'result':
        return json(200, { ok: true, accepted: bridge.settle(parsed.id, parsed) })
      case 'status':
        return json(200, {
          ok: true,
          online: bridge.online(),
          pending: bridge.pending(),
          waiting: bridge.waiting(),
          lastSeen: bridge.lastSeen(),
        })
      default:
        return json(404, { ok: false, error: { code: 'not_found' } })
    }
  }

  return { handle }
}
