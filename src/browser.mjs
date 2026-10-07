/**
 * Browser entry for b8g.
 *
 * Boots the *same* engine the CLI and HTTP server use, entirely in the page:
 * capability runtime, stack VM, snapshots and the compiler feedback interface.
 * The Node-backed compiler adapters (GCC, V8, GraalVM) report themselves as
 * unavailable here and fall back to modelled feedback, so the interface shape
 * is identical to the server's.
 *
 * The console imports this module and talks to it through the shared
 * `apiRoutes` table, which is also what src/server.mjs serves over HTTP.
 */
import { Engine } from './runtime/engine.mjs';
import { apiRoutes } from './runtime/api.mjs';
import { B8GError } from './runtime/errors.mjs';

export function bootBrowserEngine(opts = {}) {
  const engine = Engine.boot({ name: opts.name ?? 'b8g (in-page)' });
  const routes = apiRoutes(engine);

  const listeners = new Set();
  engine.watch((event) => {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch {
        /* a listener must never break the kernel */
      }
    }
  });

  return {
    engine,
    routes,
    /** Invoke an API route exactly as the HTTP server would. */
    call(method, path, body = {}) {
      const handler = routes[`${method.toUpperCase()} ${path}`];
      if (!handler) throw new B8GError(`no route for ${method} ${path}`, 'NO_ROUTE');
      return handler({ body });
    },
    /** Subscribe to kernel events (the `watch` verb). */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export { Engine };
export * from './index.mjs';
