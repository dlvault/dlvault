import { describe, it, expect } from 'vitest';
import Transport from 'winston-transport';
import { logger } from '../../src/utils/logger';

/** Captures what reaches the transports after the logger-level formats ran. */
class Capture extends Transport {
  lines: any[] = [];
  log(info: any, next: () => void) { this.lines.push(info); next(); }
}

describe('logger', () => {
  it('keeps extra arguments instead of silently dropping them', () => {
    // "Unhandled route error:" used to arrive without message and stack.
    const cap = new Capture();
    logger.add(cap);
    try {
      logger.error('Route failed:', 'boom', 'at line 1');
      logger.warn('with meta', { stack: 'x' });
    } finally {
      logger.remove(cap);
    }
    expect(cap.lines[0].message).toBe('Route failed: boom at line 1');
    expect(cap.lines[1].message).toBe('with meta');
    expect(cap.lines[1].stack).toBe('x');
  });
});
