import { extractRenderedText } from './extract.js'

// Firefox exposes the promise-based `browser.*` namespace; Chrome exposes
// promise-based `chrome.*` in MV3. One shim keeps this worker identical in both.
const api = globalThis.browser ?? globalThis.chrome

const FETCH_TIMEOUT_MS = 3_000
const REVIVE_ALARM = 'dsh-browser-tabs-revive'
/** Which browser this worker runs in, for the Host's job routing. */
function browserName() {
  const ua = navigator.userAgent
  if (/firefox/iu.test(ua)) return 'Firefox'
  if (/edg\//iu.test(ua)) return 'Edge'
  if (/chrome/iu.test(ua)) return 'Chrome'
  return 'Browser'
}

const CLIENT_ID = `${browserName()}-${Math.random().toString(36).slice(2, 8)}`
let polling = false

/** Read the host address and optional token the user saved in the popup. */
async function settings() {
  const { host, token } = await api.storage.local.get({ host: 'http://127.0.0.1:3080', token: '' })
  return { host: String(host || 'http://127.0.0.1:3080').replace(/\/+$/u, ''), token: String(token ?? '') }
}

/** One POST to the host endpoint, bounded so a dead host cannot wedge the worker. */
async function post(path, body, timeoutMs = FETCH_TIMEOUT_MS) {
  const { host, token } = await settings()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${host}/dsh-browser-tabs/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, token, ...body }),
      signal: controller.signal,
    })
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Default target when the command names no tab: the first readable tab, the
 * same one `/browser list` numbers as 1. DSH's own page is not special-cased.
 */
async function defaultTab() {
  try {
    const tabs = await api.tabs.query({})
    for (const tab of tabs) {
      if (!tab.url || /^(chrome|edge|about|devtools|moz-extension|chrome-extension):/u.test(tab.url)) continue
      return tab
    }
  } catch {
    // Fall through to the active tab below.
  }
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true })
  return tab
}

/** Extract the rendered text of one tab (defaults to the active one). */
async function readTab(tabId) {
  let tab
  try {
    tab = tabId === undefined ? await defaultTab() : await api.tabs.get(tabId)
  } catch {
    return { ok: false, error: { code: 'tab_closed', message: 'the tab no longer exists' } }
  }
  if (!tab?.id) return { ok: false, error: { code: 'tab_closed', message: 'no active tab' } }
  if (typeof api.scripting?.executeScript !== 'function') {
    return { ok: false, error: { code: 'inject_denied', message: 'this browser does not expose scripting.executeScript' } }
  }
  try {
    // The isolated world sees the same DOM and computed styles, and is the one
    // context both Chrome and Firefox accept without extra flags.
    const [injection] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractRenderedText,
    })
    const value = injection?.result ?? {}
    return {
      ok: true,
      data: {
        tab: {
          id: tab.id,
          title: value.title || tab.title || '',
          url: value.url || tab.url || '',
        },
        text: String(value.text ?? ''),
        frames: Number(value.frames ?? 1),
      },
    }
  } catch (error) {
    return { ok: false, error: { code: 'inject_denied', message: String(error?.message ?? error) } }
  }
}

/** List every readable tab. Browser-internal pages cannot be injected. */
async function listTabs() {
  const tabs = await api.tabs.query({})
  return {
    ok: true,
    data: {
      browser: browserName(),
      tabs: tabs
        .filter((tab) => tab.url && !/^(chrome|edge|about|devtools|chrome-extension|moz-extension):/u.test(tab.url))
        .map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.active === true })),
    },
  }
}

async function handle(job) {
  if (job.kind === 'list') return listTabs()
  return readTab(job.tabId)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let socket

/** True when this browser has the DSH page open somewhere. */
async function dshTabOpen() {
  try {
    const { host } = await settings()
    const origin = new URL(host).origin
    const tabs = await api.tabs.query({})
    return tabs.some((tab) => typeof tab.url === 'string' && tab.url.startsWith(origin))
  } catch {
    return false
  }
}

/** Keep one WebSocket open: Chrome and Firefox both extend worker lifetime on socket traffic. */
async function connectSocket() {
  if (socket !== undefined) return
  let url
  try {
    const { host, token } = await settings()
    url = `${host.replace(/^http/u, 'ws')}/dsh-browser-tabs/ws`
    socket = new WebSocket(url)
    socket.addEventListener('open', () => {
      void (async () => {
        socket?.send(JSON.stringify({
          type: 'hello',
          clientId: CLIENT_ID,
          token,
          browser: browserName(),
          hasDsh: await dshTabOpen(),
        }))
      })()
    })
    socket.addEventListener('message', (event) => { void onSocketMessage(event.data) })
    socket.addEventListener('close', () => {
      socket = undefined
      setTimeout(() => { void connectSocket() }, 1_500)
    })
    socket.addEventListener('error', () => {})
  } catch {
    socket = undefined
    setTimeout(() => { void connectSocket() }, 3_000)
  }
}

/** Answer the keepalive and execute pushed jobs. */
async function onSocketMessage(raw) {
  let message
  try {
    message = JSON.parse(raw)
  } catch {
    return
  }
  if (message?.type === 'ping') {
    safeSend({ type: 'pong', hasDsh: await dshTabOpen() })
    return
  }
  if (message?.type !== 'job') return
  let result
  try {
    result = await handle(message)
  } catch (error) {
    result = { ok: false, error: { code: 'extension_error', message: String(error?.message ?? error) } }
  }
  safeSend({ type: 'result', id: message.id, ...result })
}

function safeSend(value) {
  try {
    if (socket?.readyState === 1) socket.send(JSON.stringify(value))
  } catch {
    // The socket died mid-send; the HTTP fallback still covers delivery.
  }
}

/**
 * One long-lived poll loop. `waitMs` makes the host hold the request open when
 * there is nothing to do, so the extension always has a fetch in flight — that
 * is what keeps an MV3 service worker (Chrome) or event page (Firefox) alive.
 * The alarm below restarts the loop if the browser kills it anyway.
 */
async function runLoop() {
  if (looping) return
  looping = true
  try {
    for (;;) {
      let answer
      try {
        answer = await post('poll', { waitMs: POLL_HOLD_MS }, POLL_TIMEOUT_MS)
      } catch {
        // Host down or restarting: back off briefly and retry.
        await sleep(1_000)
        continue
      }
      for (const job of answer?.requests ?? []) {
        let result
        try {
          result = await handle(job)
        } catch (error) {
          result = { ok: false, error: { code: 'extension_error', message: String(error?.message ?? error) } }
        }
        try {
          await post('result', { id: job.id, ...result })
        } catch {
          // The host vanished mid-job; the loop will reconnect.
        }
      }
    }
  } finally {
    looping = false
  }
}

api.runtime.onInstalled.addListener(() => { void connectSocket(); void runLoop() })
api.runtime.onStartup.addListener(() => { void connectSocket(); void runLoop() })

// Tab activity wakes the worker; any wake also resumes the loop from the top
// level of this module, so these listeners mainly make the wake-up explicit.
api.tabs.onActivated.addListener(() => {
  void connectSocket()
  void runLoop()
})
api.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status !== 'complete') return
  void connectSocket()
  void runLoop()
})

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'status') {
    post('status', {}).then(sendResponse, () => sendResponse({ ok: false }))
    return true
  }
  return false
})

// The worker (Chrome) or event page (Firefox) is unloaded when idle. The held
// poll keeps it busy, but if the browser kills it anyway this alarm is the
// durable heartbeat that restarts the loop. One minute is the lowest periodic
// value Firefox accepts, and Chrome accepts it too.
function ensureReviveAlarm() {
  void api.alarms.create(REVIVE_ALARM, { periodInMinutes: 1 })
}

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== REVIVE_ALARM) return
  void connectSocket()
  void runLoop()
})

try {
  ensureReviveAlarm()
  void connectSocket()
  void runLoop()
} catch (error) {
  // Keep a trace on the worker global so `chrome://extensions` > inspect shows it.
  self.__dshStartupError = String(error?.stack ?? error)
}
