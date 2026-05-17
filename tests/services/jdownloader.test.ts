import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const mockSettings: Record<string, string> = {};

vi.mock('../../src/database/index', () => ({
  getSetting: vi.fn((key: string) => mockSettings[key] || ''),
  setSetting: vi.fn(),
  initDatabase: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { JDownloaderService } from '../../src/jdownloader/index';

describe('JDownloaderService', () => {
  let service: JDownloaderService;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    service = new JDownloaderService();
  });

  describe('isConfigured', () => {
    it('should return false when no credentials', () => {
      expect(service.isConfigured()).toBe(false);
    });

    it('should return false when only email is set', () => {
      mockSettings['jdownloader.email'] = 'test@test.com';
      expect(service.isConfigured()).toBe(false);
    });

    it('should return true when both email and password are set', () => {
      mockSettings['jdownloader.email'] = 'test@test.com';
      mockSettings['jdownloader.password'] = 'pass123';
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('connect', () => {
    it('should return false when not configured', async () => {
      const result = await service.connect();
      expect(result).toBe(false);
    });

    it('should return false on connection error', async () => {
      mockSettings['jdownloader.email'] = 'test@test.com';
      mockSettings['jdownloader.password'] = 'pass';

      mockedAxios.get.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await service.connect();
      expect(result).toBe(false);
    });

    it('should reuse session within TTL', async () => {
      mockSettings['jdownloader.email'] = 'test@test.com';
      mockSettings['jdownloader.password'] = 'pass';

      // Manually set up session state
      (service as any).sessionToken = 'existing-token';
      (service as any).lastConnectTime = Date.now();

      const result = await service.connect();
      expect(result).toBe(true);
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('should coalesce concurrent connect calls', async () => {
      mockSettings['jdownloader.email'] = 'test@test.com';
      mockSettings['jdownloader.password'] = 'pass';

      mockedAxios.get.mockRejectedValue(new Error('error'));

      const [r1, r2] = await Promise.all([
        service.connect(),
        service.connect(),
      ]);

      // Both should get the same result
      expect(r1).toBe(false);
      expect(r2).toBe(false);
      // Only one HTTP call
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('listDevices', () => {
    it('should return empty array when not connected', async () => {
      const devices = await service.listDevices();
      expect(devices).toEqual([]);
    });
  });

  describe('getDownloadPackages', () => {
    it('should return empty array when no session', async () => {
      const packages = await service.getDownloadPackages();
      expect(packages).toEqual([]);
    });
  });

  describe('getDownloadLinks', () => {
    it('should return empty array when no session', async () => {
      const links = await service.getDownloadLinks();
      expect(links).toEqual([]);
    });
  });

  describe('getLinkGrabberPackages', () => {
    it('should return empty array when no session', async () => {
      const packages = await service.getLinkGrabberPackages();
      expect(packages).toEqual([]);
    });
  });

  describe('startDownloads', () => {
    it('should return false when no session', async () => {
      const result = await service.startDownloads();
      expect(result).toBe(false);
    });
  });

  describe('stopDownloads', () => {
    it('should return false when no session', async () => {
      const result = await service.stopDownloads();
      expect(result).toBe(false);
    });
  });

  describe('pauseDownloads', () => {
    it('should return false when no session', async () => {
      const result = await service.pauseDownloads(true);
      expect(result).toBe(false);
    });
  });

  describe('removePackages', () => {
    it('should return false when no session', async () => {
      const result = await service.removePackages([1, 2]);
      expect(result).toBe(false);
    });
  });

  describe('getSpeedLimit', () => {
    it('should return 0 when no session', async () => {
      const limit = await service.getSpeedLimit();
      expect(limit).toBe(0);
    });
  });

  describe('setSpeedLimit', () => {
    it('should return false when no session', async () => {
      const result = await service.setSpeedLimit(5000);
      expect(result).toBe(false);
    });
  });

  describe('isSpeedLimited', () => {
    it('should return false when no session', async () => {
      const result = await service.isSpeedLimited();
      expect(result).toBe(false);
    });
  });

  describe('setSpeedLimitEnabled', () => {
    it('should return false when no session', async () => {
      const result = await service.setSpeedLimitEnabled(true);
      expect(result).toBe(false);
    });
  });
});
