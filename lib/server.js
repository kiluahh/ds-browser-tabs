import { MAX_BODY_BYTES } from './meta.js'

/**
 * Collect one request body with a hard ceiling. The extension sends at most a
 * few hundred KB of text or one PNG, so 8 MiB is generous while still stopping
 * a runaway client from exhausting memory.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { code: 'body_too_large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Mount the endpoint factory on one `webServer` prefix route. The Host route
 * hands us a raw `(req, res)` pair; this adapter is the only place that knows
 * about sockets, so `routes.js` stays testable as plain functions.
 */
export function createRouteHandler({ endpoint, onError }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const body = req.method === 'POST' ? await readBody(req, MAX_BODY_BYTES) : ''
      // A held poll must stop waiting when the browser goes away.
      const disconnect = new AbortController()
      res.on('close', () => disconnect.abort())
      const result = await endpoint.handle({
        method: req.method ?? 'GET',
        pathname: url.pathname,
        body,
        signal: disconnect.signal,
      })
      res.writeHead(result.status, result.headers)
      res.end(result.body === null ? undefined : JSON.stringify(result.body))
    } catch (error) {
      onError?.(error)
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: { code: error?.code ?? 'bad_request' } }))
    }
  }
}
