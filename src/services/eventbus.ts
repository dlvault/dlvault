import { Response } from 'express';
import { logger } from '../utils/logger';

type SSEClient = Response;

const MAX_SSE_CLIENTS = 50;

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
