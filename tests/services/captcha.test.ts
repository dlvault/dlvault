import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import { CaptchaService } from '../../src/services/captcha';

describe('CaptchaService', () => {
  let service: CaptchaService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    Object.keys(mockSettings).forEach(k => delete mockSettings[k]);
    service = new CaptchaService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isConfigured', () => {
    it('returns false when no key is set', () => {
      expect(service.isConfigured()).toBe(false);
    });

    it('returns true when the 2Captcha key is set', () => {
      mockSettings['secret-store.2captcha-api-key'] = 'test-key';
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('reports 2Captcha as unconfigured by default', () => {
      expect(service.getStatus()).toEqual({ twocaptcha: false });
    });

    it('reports 2Captcha as configured when the key is set', () => {
      mockSettings['secret-store.2captcha-api-key'] = 'key';
      expect(service.getStatus()).toEqual({ twocaptcha: true });
    });
  });

  describe('solveCaptcha', () => {
    it('returns null when 2Captcha is not configured', async () => {
      const result = await service.solveCaptcha('siteKey', 'https://example.com', 'recaptcha');
      expect(result).toBeNull();
    });

    it('uses 2Captcha for recaptcha', async () => {
      mockSettings['secret-store.2captcha-api-key'] = '2c-key';
      mockedAxios.get.mockResolvedValueOnce({ data: { status: 1, request: 'req-id' } });
      mockedAxios.get.mockResolvedValueOnce({ data: { status: 1, request: 'captcha-solution' } });

      const resultPromise = service.solveCaptcha('siteKey', 'https://example.com', 'recaptcha');
      await vi.advanceTimersByTimeAsync(6000);
      const result = await resultPromise;

      expect(result).toEqual({ solution: 'captcha-solution', provider: '2captcha' });
    });

    it('uses 2Captcha for puzzle type', async () => {
      mockSettings['secret-store.2captcha-api-key'] = '2c-key';
      mockedAxios.get.mockResolvedValueOnce({ data: { status: 1, request: 'req-id' } });
      mockedAxios.get.mockResolvedValueOnce({ data: { status: 1, request: 'puzzle-solution' } });

      const resultPromise = service.solveCaptcha('siteKey', 'https://example.com', 'puzzle');
      await vi.advanceTimersByTimeAsync(6000);
      const result = await resultPromise;

      expect(result).toEqual({ solution: 'puzzle-solution', provider: '2captcha' });
    });

    it('uses 2Captcha for click type as well (single provider)', async () => {
      mockSettings['secret-store.2captcha-api-key'] = '2c-key';
      mockedAxios.get.mockResolvedValueOnce({ data: { status: 1, request: 'req-id' } });
      mockedAxios.get.mockResolvedValueOnce({ data: { status: 1, request: 'click-solution' } });

      const resultPromise = service.solveCaptcha('siteKey', 'https://example.com', 'click');
      await vi.advanceTimersByTimeAsync(6000);
      const result = await resultPromise;

      expect(result).toEqual({ solution: 'click-solution', provider: '2captcha' });
    });
  });
});
