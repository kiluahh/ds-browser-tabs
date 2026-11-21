/** Shared constants and config normalization for the browser-tab plugin. */

export const DEFAULT_ROUTE_PREFIX = '/dsh-browser-tabs'
export const DEFAULT_TIMEOUT_MS = 8_000
export const ONLINE_WINDOW_MS = 3_000
export const MAX_TEXT_CHARS = 200_000
export const MAX_BODY_BYTES = 1024 * 1024
export const MAX_POLL_HOLD_MS = 20_000

/** Clamp a route prefix to a well-formed leading-slash path without a trailing slash. */
export function normalizeRoutePrefix(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw.length === 0) return DEFAULT_ROUTE_PREFIX
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  return withSlash.length > 1 ? withSlash.replace(/\/+$/u, '') : withSlash
}

/** Normalize user config; every tunable lives here so cordis.patch.yml can override it. */
export function resolveConfig(config = {}) {
  const timeout = Number(config.timeoutMs)
  return {
    routePrefix: normalizeRoutePrefix(config.routePrefix),
    token: typeof config.token === 'string' ? config.token : '',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  }
}
