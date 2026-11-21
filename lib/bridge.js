import { randomUUID } from 'node:crypto'
import { ONLINE_WINDOW_MS } from './meta.js'

/**
 * One in-memory request queue shared by the Host tools and the extension.
 * The browser cannot be called directly, so each read becomes a pending entry
 * that the extension polls for and settles by id.
 * @param {{ timeoutMs?: number, onlineWindowMs?: number, now?: () => number }} [options]
 */
export function createBridge(options = {}) {
  const timeoutMs = options.timeoutMs ?? 8_000
  const onlineWindowMs = options.onlineWindowMs ?? ONLINE_WINDOW_MS
  const now = options.now ?? Date.now
  const pending = new Map()
  const waiters = new Map()
  let lastPollAt = 0
  let waiterSeq = 0
  let presence = () => false

  /** Remove and return every request this extension has not seen yet. */
  function takeJobs() {
    const jobs = []
    for (const entry of pending.values()) {
      if (entry.settled || entry.polled) continue
      entry.polled = true
      jobs.push({ id: entry.id, kind: entry.kind, ...(entry.tabId === undefined ? {} : { tabId: entry.tabId }) })
    }
    return jobs
  }

  /** Hand a freshly queued job straight to a request that is already waiting. */
  function flushWaiters() {
    if (waiters.size === 0) return
    const jobs = takeJobs()
    if (jobs.length === 0) return
    for (const [id, waiter] of waiters) {
      clearTimeout(waiter.timer)
      waiters.delete(id)
      waiter.resolve(jobs)
      return
    }
  }

  /** Fail one request loudly instead of leaving the caller waiting. */
  function fail(entry, code, message) {
    if (entry.settled) return false
    entry.settled = true
    clearTimeout(entry.timer)
    entry.resolve({ error: { code, message } })
    return true
  }

  return {
    /** Register one request; resolves with the extension payload or `{ error }`. */
    request({ kind, tabId, signal } = {}) {
      return new Promise((resolve) => {
        const id = randomUUID()
        const entry = { id, kind, tabId, resolve, settled: false, polled: false, timer: undefined }
        pending.set(id, entry)
        entry.timer = setTimeout(() => {
          if (fail(entry, 'timeout', `the extension did not answer within ${timeoutMs} ms`)) pending.delete(id)
        }, timeoutMs)
        signal?.addEventListener('abort', () => {
          if (fail(entry, 'aborted', 'the request was cancelled')) pending.delete(id)
        }, { once: true })
        flushWaiters()
      })
    },

    /**
     * Hand out every request the extension has not seen yet, or hold the call
     * open for `waitMs` so the extension has a pending fetch keeping its
     * service worker alive. Entries stay in `pending` until they settle, time
     * out, or abort, so the result that comes back can still find its request.
     */
    poll({ waitMs = 0, signal } = {}) {
      lastPollAt = now()
      const jobs = takeJobs()
      if (jobs.length > 0 || waitMs <= 0) return jobs
      return new Promise((resolve) => {
        const id = ++waiterSeq
        const waiter = { resolve, timer: undefined }
        waiter.timer = setTimeout(() => {
          waiters.delete(id)
          resolve([])
        }, waitMs)
        waiters.set(id, waiter)
        signal?.addEventListener('abort', () => {
          if (!waiters.delete(id)) return
          clearTimeout(waiter.timer)
          resolve([])
        }, { once: true })
      })
    },

    /** Resolve the request a result belongs to; `false` means unknown or already settled. */
    settle(id, payload) {
      const entry = pending.get(id)
      if (entry === undefined || entry.settled) return false
      pending.delete(id)
      entry.settled = true
      clearTimeout(entry.timer)
      if (payload?.ok === false) {
        entry.resolve({ error: payload.error ?? { code: 'extension_error', message: 'the extension reported a failure' } })
      } else {
        entry.resolve(payload?.data ?? {})
      }
      return true
    },

    /**
     * True when the extension currently holds a poll open or polled recently.
     * A live long-poll is the strongest signal: the worker is awake right now.
     */
    online() {
      return waiters.size > 0 || presence() || (lastPollAt > 0 && now() - lastPollAt <= onlineWindowMs)
    },

    /** Let a push transport (the WebSocket carrier) report its own reachability. */
    attachPresence(source) {
      presence = typeof source === 'function' ? source : () => false
      return () => { presence = () => false }
    },

    /** How many poll calls are currently held open. */
    waiting() {
      return waiters.size
    },

    /** Last poll timestamp, for user-facing diagnostics. */
    lastSeen() {
      return lastPollAt
    },

    /** How many requests are still waiting for an answer, polled or not. */
    pending() {
      return pending.size
    },
  }
}
