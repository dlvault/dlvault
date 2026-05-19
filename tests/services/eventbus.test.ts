import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { eventBus } from '../../src/services/eventbus';

function mockClient() {
  return { write: vi.fn(), writable: true } as any;
}

describe('EventBus', () => {
  beforeEach(() => {
    // Remove all clients between tests
    while (eventBus.clientCount > 0) {
      // Access internals to clean up
      const client = mockClient();
      eventBus.removeClient(client);
    }
  });

  it('should add and remove clients', () => {
    const client = mockClient();
    eventBus.addClient(client);
    expect(eventBus.clientCount).toBeGreaterThanOrEqual(1);

    eventBus.removeClient(client);
  });

  it('should emit events to all connected clients', () => {
    const client1 = mockClient();
    const client2 = mockClient();

    eventBus.addClient(client1);
    eventBus.addClient(client2);

    eventBus.emit('test:event', { foo: 'bar' });

    const expectedPayload = JSON.stringify({ event: 'test:event', data: { foo: 'bar' } });
    const expectedMessage = `data: ${expectedPayload}\n\n`;

    expect(client1.write).toHaveBeenCalledWith(expectedMessage);
    expect(client2.write).toHaveBeenCalledWith(expectedMessage);

    eventBus.removeClient(client1);
    eventBus.removeClient(client2);
  });

  it('should handle client write errors gracefully', () => {
    const goodClient = mockClient();
    const badClient = mockClient();
    badClient.write.mockImplementation(() => { throw new Error('Client gone'); });

    eventBus.addClient(goodClient);
    eventBus.addClient(badClient);

    // Should not throw
    eventBus.emit('test:event', { data: 1 });

    expect(goodClient.write).toHaveBeenCalled();

    eventBus.removeClient(goodClient);
  });

  it('should track client count correctly', () => {
    const initialCount = eventBus.clientCount;
    const client = mockClient();

    eventBus.addClient(client);
    expect(eventBus.clientCount).toBe(initialCount + 1);

    eventBus.removeClient(client);
    expect(eventBus.clientCount).toBe(initialCount);
  });
});
