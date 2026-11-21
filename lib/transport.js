import { upgrade } from './ws.js'

/**
 * Push transport: the extension holds one WebSocket open, the Host sends jobs
 * over it. This is the documented way to keep a Manifest V3 service worker
 * alive (Chrome 116+: WebSocket messages reset the idle timer); the HTTP
 * long-poll remains as a fallback for environments that block upgrades.
 */
export function createTransport({ bridge, config, flushEveryMs = 200, pingEveryMs = 20_000 }) {
  // id -> { connection, browser, hasDsh, dshFocused, seenAt }
  const clients = new Map()
  let flushTimer
  let pingTimer
  let disposed = false

  const detachPresence = bridge.attachPresence(() => clients.size > 0)

  /**
   * Which extension should get the next job. The browser the user has DSH open
   * in is the one they are talking to, so prefer it; otherwise the freshest
   * connection wins. Without this, two connected browsers race and a Chrome
   * request can be answered by the Firefox extension.
   */
  function pick() {
    const list = [...clients.values()]
    if (list.length === 0) return undefined
    const freshest = list.sort((a, b) => b.seenAt - a.seenAt)
    return (freshest.find((client) => client.dshFocused)
      ?? freshest.find((client) => client.hasDsh)
      ?? freshest[0]).connection
  }

  function flush() {
    const client = pick()
    if (client === undefined) return
    const jobs = bridge.poll()
    if (jobs.length === 0) return
    for (const job of jobs) client.send({ type: 'job', ...job })
  }

  function ensureTimers() {
    if (flushTimer !== undefined || disposed) return
    flushTimer = setInterval(flush, flushEveryMs)
    pingTimer = setInterval(() => {
      // Application-level ping, not a protocol ping: the extension's message
      // handler must run and answer, which is what resets the idle timer.
      for (const client of clients.values()) client.connection.send({ type: 'ping' })
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

  function accept(connection, hello) {
    const id = String(hello.clientId ?? `client-${clients.size + 1}`)
    clients.set(id, {
      connection,
      browser: String(hello.browser ?? 'browser'),
      hasDsh: hello.hasDsh === true,
      dshFocused: hello.dshFocused === true,
      seenAt: Date.now(),
    })
    ensureTimers()
    connection.send({ type: 'welcome', online: true, clients: clients.size })
    flush()
  }

  function drop(connection) {
    for (const [id, client] of clients) {
      if (client.connection === connection) clients.delete(id)
    }
    if (clients.size === 0) stopTimers()
  }

  function note(connection, message) {
    for (const client of clients.values()) {
      if (client.connection !== connection) continue
      client.seenAt = Date.now()
      if (typeof message.hasDsh === 'boolean') client.hasDsh = message.hasDsh
      if (typeof message.dshFocused === 'boolean') client.dshFocused = message.dshFocused
      if (typeof message.browser === 'string') client.browser = message.browser
    }
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
        accept(connection, message)
        return
      }
      if (!greeted) return
      if (message?.type === 'result') {
        bridge.settle(message.id, message)
        return
      }
      if (message?.type === 'pong' || message?.type === 'state') {
        note(connection, message)
        return
      }
      if (message?.type === 'ping') connection.send({ type: 'pong' })
    })
  }

  return {
    handleUpgrade,
    /** Number of extensions currently holding a socket open. */
    connections: () => clients.size,

    /** One row per connected extension, for `/browser status`. */
    clients: () => [...clients.values()].map((client) => ({
      browser: client.browser,
      hasDsh: client.hasDsh,
      dshFocused: client.dshFocused,
      seenAt: client.seenAt,
    })),
    dispose() {
      disposed = true
      stopTimers()
      detachPresence()
      for (const client of clients.values()) client.connection.close(1001, 'plugin unloaded')
      clients.clear()
    },
  }
}
