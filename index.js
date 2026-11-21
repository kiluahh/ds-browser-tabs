import { apply as applyHost } from './lib/host.js'

export const name = 'ds-browser-tabs'
export const inject = ['commands']

export function apply(ctx, config = {}) {
  return applyHost(ctx, config)
}

export default { name, inject, apply }
