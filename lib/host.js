import { createBridge } from './bridge.js'
import { createEndpoint } from './routes.js'
import { createRouteHandler } from './server.js'
import { createTransport } from './transport.js'
import { resolveConfig } from './meta.js'
import { registerCommands } from './commands.js'
import { registerTools } from './tools.js'

/**
 * Build the Host half without touching Cordis. Exported so the test suite can
 * drive the real bridge and the real route handler.
 */
export function createHostRuntime(config = {}) {
  const resolved = resolveConfig(config)
  const bridge = createBridge({ timeoutMs: resolved.timeoutMs })
  const endpoint = createEndpoint({ bridge, config: resolved })
  const routeHandler = createRouteHandler({ endpoint })
  const transport = createTransport({ bridge, config: resolved })
  return { config: resolved, bridge, endpoint, routeHandler, transport }
}

export function apply(ctx, config = {}) {
  const runtime = createHostRuntime(config)
  const onError = (error) => ctx.logger?.warn?.(`ds-browser-tabs: ${error?.message ?? error}`)

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: runtime.config.routePrefix,
      handler: (req, res) => runtime.routeHandler(req, res),
    }), 'ds-browser-tabs: extension route')
    scope.effect(() => scope.webServer.registerUpgrade({
      path: `${runtime.config.routePrefix}/ws`,
      handler: (req, socket, head) => runtime.transport.handleUpgrade(req, socket, head),
    }), 'ds-browser-tabs: extension socket')
    scope.effect(() => () => runtime.transport.dispose(), 'ds-browser-tabs: socket teardown')
  })

  const deps = {
    bridge: runtime.bridge,
    config: runtime.config,
    stats: () => ({
      online: runtime.bridge.online(),
      waiting: runtime.bridge.waiting(),
      pending: runtime.bridge.pending(),
      lastSeen: runtime.bridge.lastSeen(),
      connections: runtime.transport.connections(),
    }),
  }
  registerCommands(ctx, deps)
  ctx.inject(['tools'], (scope) => registerTools(scope, deps))
  return runtime
}

export default { apply }
