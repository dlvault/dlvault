import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSettings: Record<string, string> = {};

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] || ''),
  setSetting: vi.fn(),
  initDatabase: vi.fn(),
}));

vi.mock('../../src/jdownloader/index', () => ({
  jdownloaderService: {
    isConfigured: vi.fn(() => true),
    connect: vi.fn(() => Promise.resolve(true)),
    setSpeedLimit: vi.fn(() => Promise.resolve()),
    setSpeedLimitEnabled: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { checkAndApplyLimit, startBandwidthScheduler, stopBandwidthScheduler } from '../../src/services/bandwidth';
import { jdownloaderService } from '../../src/jdownloader/index';

describe('Bandwidth Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset settings
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    // Stop any running scheduler
    stopBandwidthScheduler();
  });

  afterEach(() => {
    stopBandwidthScheduler();
    vi.useRealTimers();
  });

  it('should do nothing if bandwidth scheduling is disabled', async () => {
    mockSettings['bandwidth.schedule_enabled'] = 'false';
    await checkAndApplyLimit();
    expect(jdownloaderService.connect).not.toHaveBeenCalled();
  });

  it('should do nothing if JDownloader is not configured', async () => {
    mockSettings['bandwidth.schedule_enabled'] = 'true';
    vi.mocked(jdownloaderService.isConfigured).mockReturnValueOnce(false);
    await checkAndApplyLimit();
    expect(jdownloaderService.connect).not.toHaveBeenCalled();
  });

  it('should disable speed limiter when night limit is 0 (unlimited)', async () => {
    mockSettings['bandwidth.schedule_enabled'] = 'true';
    mockSettings['bandwidth.day_start'] = '8';
    mockSettings['bandwidth.day_end'] = '23';
    mockSettings['bandwidth.day_limit_kbps'] = '5000';
    mockSettings['bandwidth.night_limit_kbps'] = '0';

    // Simulate nighttime (hour 3)
    vi.setSystemTime(new Date('2026-04-04T03:00:00'));

    await checkAndApplyLimit();

    expect(jdownloaderService.setSpeedLimitEnabled).toHaveBeenCalledWith(false);
  });

  it('should apply day limit during daytime', async () => {
    mockSettings['bandwidth.schedule_enabled'] = 'true';
    mockSettings['bandwidth.day_start'] = '8';
    mockSettings['bandwidth.day_end'] = '23';
    mockSettings['bandwidth.day_limit_kbps'] = '5000';
    mockSettings['bandwidth.night_limit_kbps'] = '0';

    // Simulate daytime (hour 14)
    vi.setSystemTime(new Date('2026-04-04T14:00:00'));

    await checkAndApplyLimit();

    expect(jdownloaderService.setSpeedLimit).toHaveBeenCalledWith(5000);
    expect(jdownloaderService.setSpeedLimitEnabled).toHaveBeenCalledWith(true);
  });

  it('should not start scheduler if disabled', () => {
    mockSettings['bandwidth.schedule_enabled'] = 'false';
    startBandwidthScheduler();
    // No interval should be running — stopping again should be safe
    stopBandwidthScheduler();
  });
});
