import { upgrade } from './ws.js'

/**
 * Push transport: the extension holds one WebSocket open, the Host sends jobs
 * over it. This is the documented way to keep a Manifest V3 service worker
 * alive (Chrome 116+: WebSocket messages reset the idle timer); the HTTP
 * long-poll remains as a fallback for environments that block upgrades.
 */
export function createTransport({ bridge, config, flushEveryMs = 200, pingEveryMs = 20_000 }) {
  const clients = new Set()
  let flushTimer
  let pingTimer
  let disposed = false

  const detachPresence = bridge.attachPresence(() => clients.size > 0)

  function flush() {
    if (clients.size === 0) return
    const jobs = bridge.poll()
    if (jobs.length === 0) return
    const [client] = clients
    for (const job of jobs) client.send({ type: 'job', ...job })
  }

  function ensureTimers() {
    if (flushTimer !== undefined || disposed) return
    flushTimer = setInterval(flush, flushEveryMs)
    pingTimer = setInterval(() => {
      // Application-level ping, not a protocol ping: the extension's message
      // handler must run and answer, which is what resets the idle timer.
      for (const client of clients) client.send({ type: 'ping' })
    }, pingEveryMs)
    flushTimer.unref?.()
    pingTimer.unref?.()
  }

  function stopTimers() {
    if (flushTimer !== undefined) clearInterval(flushTimer)
    if (pingTimer !== undefined) clearInterval(pingTimer)
    flushTimer = undefined
    pingTimer = undefined
  }

  function accept(client) {
    clients.add(client)
    ensureTimers()
    client.send({ type: 'welcome', online: true })
    flush()
  }

  function drop(client) {
    clients.delete(client)
    if (clients.size === 0) stopTimers()
  }

  /** Raw `webServer.registerUpgrade` handler. */
  function handleUpgrade(req, socket, head) {
    if (disposed) {
      socket.destroy()
      return
    }
    const connection = upgrade(req, socket, head)
    if (connection === undefined) {
      socket.destroy()
      return
    }

    let greeted = false
    connection.onEvent((event) => {
      if (event.kind === 'close') {
        drop(connection)
        return
      }
      if (event.kind !== 'message') return
      const message = event.value
      if (message?.type === 'hello') {
        if (config.token && message.token !== config.token) {
          connection.send({ type: 'error', code: 'unauthorized' })
          connection.close(1008, 'unauthorized')
          return
        }
        greeted = true
        accept(connection)
        return
      }
      if (!greeted) return
      if (message?.type === 'result') {
        bridge.settle(message.id, message)
        return
      }
      if (message?.type === 'ping') connection.send({ type: 'pong' })
    })
  }

  return {
    handleUpgrade,
    /** Number of extensions currently holding a socket open. */
    connections: () => clients.size,
    dispose() {
      disposed = true
      stopTimers()
      detachPresence()
      for (const client of [...clients]) client.close(1001, 'plugin unloaded')
      clients.clear()
    },
  }
}
