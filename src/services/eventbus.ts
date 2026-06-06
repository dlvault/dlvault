import { Response } from 'express';
import { logger } from '../utils/logger';

type SSEClient = Response;

const MAX_SSE_CLIENTS = 50;

/**
 * Unread bytes a single SSE client may accumulate before it is dropped.
 * Generous next to the event payloads (a few hundred bytes each), so only a
 * genuinely stalled consumer ever reaches it.
 */
const MAX_CLIENT_BUFFER_BYTES = 1024 * 1024;

class EventBus {
  private clients: Set<SSEClient> = new Set();
  private listeners = new Map<string, Set<(data: any) => void>>();

  addClient(res: SSEClient): boolean {
    if (this.clients.size >= MAX_SSE_CLIENTS) {
      logger.warn(`SSE client rejected — max ${MAX_SSE_CLIENTS} reached`);
      return false;
    }
    this.clients.add(res);
    logger.info(`SSE client connected (total: ${this.clients.size})`);
    return true;
  }

  removeClient(res: SSEClient): void {
    this.clients.delete(res);
    logger.info(`SSE client disconnected (total: ${this.clients.size})`);
  }

  on(event: string, handler: (data: any) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  removeListener(event: string, handler: (data: any) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event: string, data: object): void {
    const payload = JSON.stringify({ event, data });
    const message = `data: ${payload}\n\n`;

    for (const client of this.clients) {
      try {
        if (!client.writable) {
          this.clients.delete(client);
          continue;
        }
        // Backpressure: a client that stopped reading (laptop asleep, dead TCP
        // window) still counts as `writable`, so every event was queued into its
        // socket buffer indefinitely — download-progress events alone are enough
        // to grow that without bound. Drop such a client instead of holding its
        // backlog in memory; the browser's EventSource reconnects on its own.
        if (client.writableLength > MAX_CLIENT_BUFFER_BYTES) {
          logger.warn(`SSE client dropped — ${client.writableLength} bytes unread (not consuming the stream)`);
          this.clients.delete(client);
          try { client.end(); } catch { /* already gone */ }
          continue;
        }
        client.write(message);
      } catch {
        this.clients.delete(client);
      }
    }

    // Notify internal listeners
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(data); } catch (err: any) {
          logger.error(`EventBus handler error for '${event}': ${err?.message ?? err}`);
        }
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

export const eventBus = new EventBus();
