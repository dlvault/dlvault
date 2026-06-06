/**
 * Bound a plugin call so a hung or misbehaving plugin can't freeze the host.
 *
 * NOTE: a Promise.race timeout does NOT cancel the underlying work — the plugin
 * keeps running. That's why the `resolveLinks` budget is set ABOVE a resolver
 * worker's own ~180s self-kill: for a well-behaved plugin the plugin always
 * finishes (or kills itself) first, so the host timeout never orphans a second
 * browser/worker. It only fires as a backstop for a plugin whose internal timer
 * is missing or broken. On timeout the call rejects, which every call site
 * already handles like any other plugin failure (the item stays pending and is
 * retried under the normal backoff).
 *
 * Promise.race attaches a handler to the losing promise, so a late rejection from
 * the abandoned work is consumed (no unhandledRejection).
 */
export class PluginTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`Plugin call "${label}" timed out after ${ms}ms`);
    this.name = 'PluginTimeoutError';
  }
}

export const PLUGIN_TIMEOUTS = {
  resolveLinks: 210_000, // above a resolver worker's own ~180s self-kill — backstop only
  findReleases: 180_000, // multi-season shows legitimately exceed 60s: a source
                         // plugin scrapes each season tab with up to 3 attempts × ~8s
                         // render-poll (plus 2×45s goto budget), so a show with
                         // several seasons — or one season that never matches —
                         // was killed by the old 60s budget even though the
                         // scrape would have completed. Backstop only.
  searchTitles: 30_000,
  discover: 30_000,
  healthCheck: 15_000,
} as const;

export function withPluginTimeout<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PluginTimeoutError(label, ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
