import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import crypto from 'crypto';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const mockSettings: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Crypto helpers that mirror the production client so we can craft *valid*
// AES-encrypted server/device responses. This lets us exercise the full
// connect -> listDevices -> callDevice flow with real crypto (no mocking it).
// ---------------------------------------------------------------------------
const TEST_EMAIL = 'test@test.com';
const TEST_PASS = 'pass';

function createSecret(email: string, password: string, domain: string): Buffer {
  return crypto
    .createHash('sha256')
    .update(Buffer.from(email.toLowerCase() + password + domain, 'utf-8'))
    .digest();
}

function updateTokens(oldToken: Buffer, responseToken: string): Buffer {
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([oldToken, Buffer.from(responseToken, 'hex')]))
    .digest();
}

function encrypt(data: string, token: Buffer): string {
  const iv = token.subarray(0, 16);
  const key = token.subarray(16, 32);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf-8'), cipher.final()]);
  return encrypted.toString('base64');
}

// A realistic 64-hex-char session token (32 bytes) — required because the
// client feeds it through Buffer.from(token, 'hex') in updateTokens().
const SESSION_TOKEN = 'a'.repeat(64);
const REGAIN_TOKEN = 'b'.repeat(64);

const loginSecret = createSecret(TEST_EMAIL, TEST_PASS, 'server');
const deviceSecret = createSecret(TEST_EMAIL, TEST_PASS, 'device');
const serverEncryptionToken = updateTokens(loginSecret, SESSION_TOKEN);
const deviceEncryptionToken = updateTokens(deviceSecret, SESSION_TOKEN);

/** Build an axios-style response whose body is the encrypted JSON `obj`. */
function encryptedResponse(obj: unknown, token: Buffer) {
  return { data: encrypt(JSON.stringify(obj), token) };
}

/** A successful /my/connect body, encrypted with the login secret. */
function connectResponse() {
  return encryptedResponse(
    { sessiontoken: SESSION_TOKEN, regaintoken: REGAIN_TOKEN },
    loginSecret
  );
}

/** A successful /my/listdevices body, encrypted with the server token. */
function listDevicesResponse(devices: unknown[]) {
  return encryptedResponse({ list: devices }, serverEncryptionToken);
}

const DEFAULT_DEVICE = { id: 'dev-1', name: 'JD-Main', type: 'jd' };

/** A device action response, encrypted with the device token. */
function deviceResponse(body: unknown) {
  return encryptedResponse(body, deviceEncryptionToken);
}

function setCredentials() {
  mockSettings['jdownloader.email'] = TEST_EMAIL;
  mockSettings['jdownloader.password'] = TEST_PASS;
}

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
    // mockReset() (not just clearAllMocks) so the mockResolvedValueOnce queue
    // is fully drained between tests.
    mockedAxios.get.mockReset();
    mockedAxios.post.mockReset();
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
    it('should return null when no session (call failed)', async () => {
      const packages = await service.getDownloadPackages();
      expect(packages).toBeNull();
    });
  });

  describe('getDownloadLinks', () => {
    it('should return empty array when no session', async () => {
      const links = await service.getDownloadLinks();
      expect(links).toEqual([]);
    });
  });

  describe('getLinkGrabberPackages', () => {
    it('should return null when no session (call failed)', async () => {
      const packages = await service.getLinkGrabberPackages();
      expect(packages).toBeNull();
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

  // -------------------------------------------------------------------------
  // Full connect / device-call flow using real crypto.
  // -------------------------------------------------------------------------
  describe('connect (success path)', () => {
    beforeEach(() => setCredentials());

    it('should connect successfully and store tokens', async () => {
      mockedAxios.get.mockResolvedValueOnce(connectResponse());

      const result = await service.connect();
      expect(result).toBe(true);
      expect((service as any).sessionToken).toBe(SESSION_TOKEN);
      expect((service as any).regainToken).toBe(REGAIN_TOKEN);
      expect((service as any).serverEncryptionToken).not.toBeNull();
      expect((service as any).deviceEncryptionToken).not.toBeNull();
    });

    it('should return false when sessiontoken missing in response', async () => {
      mockedAxios.get.mockResolvedValueOnce(encryptedResponse({ foo: 'bar' }, loginSecret));

      const result = await service.connect();
      expect(result).toBe(false);
      expect((service as any).sessionToken).toBeNull();
    });

    it('should default regaintoken to null when absent', async () => {
      mockedAxios.get.mockResolvedValueOnce(
        encryptedResponse({ sessiontoken: SESSION_TOKEN }, loginSecret)
      );

      const result = await service.connect();
      expect(result).toBe(true);
      expect((service as any).regainToken).toBeNull();
    });

    it('should force-reconnect even within TTL when force=true', async () => {
      (service as any).sessionToken = 'old-token';
      (service as any).lastConnectTime = Date.now();
      mockedAxios.get.mockResolvedValueOnce(connectResponse());

      const result = await service.connect(true);
      expect(result).toBe(true);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
      expect((service as any).sessionToken).toBe(SESSION_TOKEN);
    });

    it('should surface error.response.data detail on failure', async () => {
      mockedAxios.get.mockRejectedValueOnce({ response: { data: { error: 'bad' } } });

      const result = await service.connect();
      expect(result).toBe(false);
    });
  });

  describe('listDevices (connected)', () => {
    beforeEach(() => setCredentials());

    async function connectOk() {
      mockedAxios.get.mockResolvedValueOnce(connectResponse());
      await service.connect();
      mockedAxios.get.mockReset();
    }

    it('should list devices after auto-connect', async () => {
      // Not yet connected -> listDevices triggers connect, then listdevices.
      mockedAxios.get
        .mockResolvedValueOnce(connectResponse())
        .mockResolvedValueOnce(listDevicesResponse([DEFAULT_DEVICE]));

      const devices = await service.listDevices();
      expect(devices).toEqual([DEFAULT_DEVICE]);
    });

    it('should return empty list when response has no list field', async () => {
      await connectOk();
      mockedAxios.get.mockResolvedValueOnce(encryptedResponse({}, serverEncryptionToken));

      const devices = await service.listDevices();
      expect(devices).toEqual([]);
    });

    it('should return empty array on HTTP error', async () => {
      await connectOk();
      mockedAxios.get.mockRejectedValueOnce(new Error('boom'));

      const devices = await service.listDevices();
      expect(devices).toEqual([]);
    });
  });

  // Helper: bring a service instance to a fully-connected state with a
  // resolved device id, leaving the axios mock clean for the test body.
  async function primeConnected(svc: JDownloaderService, deviceName?: string) {
    setCredentials();
    if (deviceName) mockSettings['jdownloader.device_name'] = deviceName;
    mockedAxios.get
      .mockResolvedValueOnce(connectResponse())
      .mockResolvedValueOnce(listDevicesResponse([DEFAULT_DEVICE, { id: 'dev-2', name: 'Other', type: 'jd' }]));
    // Force device-id resolution now.
    const id = await (svc as any).getDeviceId();
    mockedAxios.get.mockReset();
    return id;
  }

  describe('getDeviceId', () => {
    it('should pick device by configured name', async () => {
      const id = await primeConnected(service, 'Other');
      expect(id).toBe('dev-2');
    });

    it('should pick first device when no name configured', async () => {
      const id = await primeConnected(service);
      expect(id).toBe('dev-1');
    });

    it('should cache device id on subsequent calls', async () => {
      await primeConnected(service);
      const again = await (service as any).getDeviceId();
      expect(again).toBe('dev-1');
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('should return null when configured device not found', async () => {
      setCredentials();
      mockSettings['jdownloader.device_name'] = 'Missing';
      mockedAxios.get
        .mockResolvedValueOnce(connectResponse())
        .mockResolvedValueOnce(listDevicesResponse([DEFAULT_DEVICE]));
      const id = await (service as any).getDeviceId();
      expect(id).toBeNull();
    });

    it('should return null when no devices exist', async () => {
      setCredentials();
      mockedAxios.get
        .mockResolvedValueOnce(connectResponse())
        .mockResolvedValueOnce(listDevicesResponse([]));
      const id = await (service as any).getDeviceId();
      expect(id).toBeNull();
    });
  });

  describe('device queries (connected)', () => {
    beforeEach(async () => {
      await primeConnected(service);
    });

    it('getDownloadPackages should return decrypted data', async () => {
      const pkgs = [{ uuid: 1, name: 'Movie' }];
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: pkgs }));
      expect(await service.getDownloadPackages()).toEqual(pkgs);
    });

    it('getDownloadPackages should return [] when data missing', async () => {
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({}));
      expect(await service.getDownloadPackages()).toEqual([]);
    });

    it('getDownloadLinks should pass packageUUIDs and return data', async () => {
      const links = [{ uuid: 9, url: 'http://x' }];
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: links }));
      expect(await service.getDownloadLinks([42])).toEqual(links);
      const sent = decryptSentPost();
      expect(sent.params[0]).toContain('"packageUUIDs":[42]');
    });

    it('getDownloadLinks should work without packageIds', async () => {
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: [] }));
      expect(await service.getDownloadLinks()).toEqual([]);
    });

    it('getLinkGrabberPackages should return data', async () => {
      const pkgs = [{ uuid: 5, name: 'LG' }];
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: pkgs }));
      expect(await service.getLinkGrabberPackages()).toEqual(pkgs);
    });

    it('getLinkGrabberLinks should return data with packageIds', async () => {
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: [{ uuid: 1 }] }));
      expect(await service.getLinkGrabberLinks([7])).toHaveLength(1);
    });

    it('getExtractionQueue should return array', async () => {
      const items = [{ archiveId: 'a', progress: 50 }];
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: items }));
      expect(await service.getExtractionQueue()).toEqual(items);
    });

    it('getExtractionQueue should return [] when data is not an array', async () => {
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: { not: 'array' } }));
      expect(await service.getExtractionQueue()).toEqual([]);
    });

    it('startDownloads should return true on success', async () => {
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: null }));
      expect(await service.startDownloads()).toBe(true);
    });

    it('stopDownloads should return true on success', async () => {
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: null }));
      expect(await service.stopDownloads()).toBe(true);
    });

    it('pauseDownloads should return true on success', async () => {
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: true }));
      expect(await service.pauseDownloads(true)).toBe(true);
    });

    it('removePackages should return true on success', async () => {
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: null }));
      expect(await service.removePackages([1, 2])).toBe(true);
    });

    it('removeLinkGrabberPackages should return true on success', async () => {
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: null }));
      expect(await service.removeLinkGrabberPackages([3])).toBe(true);
    });

    it('moveLinkGrabberToDownloadlist should return true on success', async () => {
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: null }));
      expect(await service.moveLinkGrabberToDownloadlist([4])).toBe(true);
    });

    it('getSpeedLimit should return numeric kbps (converted from bytes/sec)', async () => {
      // /downloadcontroller/getSpeedLimit returns bytes/sec
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: 3072000 }));
      expect(await service.getSpeedLimit()).toBe(3000);
    });

    it('setSpeedLimit should return true on success', async () => {
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: null }));
      expect(await service.setSpeedLimit(5000)).toBe(true);
    });

    it('isSpeedLimited should return true when value is true', async () => {
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: true }));
      expect(await service.isSpeedLimited()).toBe(true);
    });

    it('isSpeedLimited should return false for non-true value', async () => {
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: false }));
      expect(await service.isSpeedLimited()).toBe(false);
    });

    it('setSpeedLimitEnabled should return true on success', async () => {
      mockedAxios.post.mockResolvedValueOnce(deviceResponse({ data: null }));
      expect(await service.setSpeedLimitEnabled(true)).toBe(true);
    });

    it('configure2CaptchaSolver should return true (two config/set calls)', async () => {
      mockedAxios.post
        .mockResolvedValueOnce(deviceResponse({ data: null }))
        .mockResolvedValueOnce(deviceResponse({ data: null }));
      expect(await service.configure2CaptchaSolver('key-123')).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });
  });

  /** Decrypt the most recent axios.post body (device action) to inspect it. */
  function decryptSentPost(): any {
    const lastCall = mockedAxios.post.mock.calls[mockedAxios.post.mock.calls.length - 1];
    const encrypted = lastCall[1] as string;
    const iv = deviceEncryptionToken.subarray(0, 16);
    const key = deviceEncryptionToken.subarray(16, 32);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    const plain = Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final(),
    ]).toString('utf-8');
    return JSON.parse(plain);
  }

  describe('callDevice error handling', () => {
    beforeEach(async () => {
      await primeConnected(service);
    });

    it('should re-auth on 403 then retry the call', async () => {
      mockedAxios.post
        .mockRejectedValueOnce({ response: { status: 403 } })
        .mockResolvedValueOnce(deviceResponse({ data: [{ uuid: 1 }] }));
      // Re-auth triggers a fresh connect (axios.get) + listdevices.
      mockedAxios.get
        .mockResolvedValueOnce(connectResponse())
        .mockResolvedValueOnce(listDevicesResponse([DEFAULT_DEVICE]));

      const pkgs = await service.getDownloadPackages();
      expect(pkgs).toEqual([{ uuid: 1 }]);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('should retry transient 500 errors with backoff', async () => {
      vi.useFakeTimers();
      mockedAxios.post
        .mockRejectedValueOnce({ response: { status: 500 } })
        .mockResolvedValueOnce(deviceResponse({ data: [] }));

      const promise = service.getDownloadPackages();
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result).toEqual([]);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('should give up after max retries on persistent transient errors', async () => {
      vi.useFakeTimers();
      mockedAxios.post.mockRejectedValue({ response: { status: 503 } });

      const promise = service.getDownloadPackages();
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result).toBeNull(); // call failed → null (distinguishes outage from empty list)
      // initial + 3 retries
      expect(mockedAxios.post).toHaveBeenCalledTimes(4);
      vi.useRealTimers();
    });

    it('should not retry on non-transient 4xx (e.g. 400) and return null', async () => {
      mockedAxios.post.mockRejectedValueOnce({ response: { status: 400 } });
      const result = await service.getDownloadPackages();
      expect(result).toBeNull();
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it('should decrypt encrypted error response bodies for logging', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 400, data: encrypt(JSON.stringify({ src: 'err' }), deviceEncryptionToken) },
      });
      const result = await service.getDownloadPackages();
      expect(result).toBeNull();
    });

    it('should fall back when error response cannot be decrypted', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 400, data: 'not-valid-base64-encrypted' },
      });
      const result = await service.getDownloadPackages();
      expect(result).toBeNull();
    });

    it('should return null when device id cannot be resolved', async () => {
      const fresh = new JDownloaderService();
      setCredentials();
      mockedAxios.get
        .mockResolvedValueOnce(connectResponse())
        .mockResolvedValueOnce(listDevicesResponse([])); // no devices -> null id
      const result = await fresh.getDownloadPackages();
      expect(result).toBeNull();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe('addLinks', () => {
    // These tests focus on the dedup/add behaviour — disable the post-add online
    // check (budget 0 → loop never runs) so they don't poll or sleep. The dead-link
    // guard has its own dedicated tests at the end of this block.
    beforeEach(() => { (service as any).deadLinkBudgetMs = 0; });

    it('should add links when no duplicate exists', async () => {
      await primeConnected(service);
      // getDownloadPackages, getLinkGrabberPackages, then addLinks call
      mockedAxios.post
        .mockResolvedValueOnce(deviceResponse({ data: [] }))
        .mockResolvedValueOnce(deviceResponse({ data: [] }))
        .mockResolvedValueOnce(deviceResponse({ data: { id: 1 } }));

      const ok = await service.addLinks(['http://a', 'http://b'], 'Movie - 1080p');
      expect(ok).toBe('sent');
      const sent = decryptSentPost();
      expect(sent.url).toBe('/linkgrabberv2/addLinks');
      expect(sent.params[0]).toContain('http://a\\nhttp://b');
    });

    it('should skip when an exact-name duplicate package exists', async () => {
      await primeConnected(service);
      mockedAxios.post
        .mockResolvedValueOnce(deviceResponse({ data: [{ uuid: 1, name: 'Movie - 1080p', bytesTotal: 5000, childCount: 3 }] }))
        .mockResolvedValueOnce(deviceResponse({ data: [] }));

      const ok = await service.addLinks(['http://a'], 'Movie - 1080p');
      expect(ok).toBe('sent');
      // No third (addLinks) call should have been made.
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('should still add when matched package is dead (0 bytes)', async () => {
      await primeConnected(service);
      mockedAxios.post
        .mockResolvedValueOnce(deviceResponse({ data: [{ uuid: 1, name: 'Movie - 1080p', bytesTotal: 0, childCount: 1 }] }))
        .mockResolvedValueOnce(deviceResponse({ data: [] }))
        .mockResolvedValueOnce(deviceResponse({ data: { id: 1 } }));

      const ok = await service.addLinks(['http://a'], 'Movie - 1080p');
      expect(ok).toBe('sent');
      expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    });

    it('should match duplicate by title prefix ignoring quality suffix', async () => {
      await primeConnected(service);
      mockedAxios.post
        .mockResolvedValueOnce(deviceResponse({ data: [{ uuid: 1, name: 'My Movie 2024', bytesTotal: 9999, childCount: 5 }] }))
        .mockResolvedValueOnce(deviceResponse({ data: [] }));

      const ok = await service.addLinks(['http://a'], 'My Movie 2024 - 720p');
      expect(ok).toBe('sent');
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('should NOT match "Foo - S1" against existing "Foo - S10" (boundary)', async () => {
      await primeConnected(service);
      // Existing: S10 of the show; we are sending S1 — must NOT be deduped.
      mockedAxios.post
        .mockResolvedValueOnce(deviceResponse({ data: [{ uuid: 1, name: 'Foo (2020) - S10 - 1080p', bytesTotal: 9999, childCount: 5 }] }))
        .mockResolvedValueOnce(deviceResponse({ data: [] }))
        .mockResolvedValueOnce(deviceResponse({ data: { id: 1 } }));

      const ok = await service.addLinks(['http://a'], 'Foo (2020) - S1 - 1080p');
      expect(ok).toBe('sent');
      // Third (addLinks) call must have been made — i.e. no false dedup.
      expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    });

    it('should still dedup an [UPGRADE]-tagged re-send of the same release', async () => {
      await primeConnected(service);
      mockedAxios.post
        .mockResolvedValueOnce(deviceResponse({ data: [{ uuid: 1, name: 'Movie (2024) - 1080p', bytesTotal: 9999, childCount: 5 }] }))
        .mockResolvedValueOnce(deviceResponse({ data: [] }));

      const ok = await service.addLinks(['http://a'], 'Movie (2024) - 1080p [UPGRADE]');
      expect(ok).toBe('sent');
      // No third call: existing package was correctly recognised as duplicate.
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('should return false when addLinks device call yields null', async () => {
      await primeConnected(service);
      mockedAxios.post
        .mockResolvedValueOnce(deviceResponse({ data: [] }))
        .mockResolvedValueOnce(deviceResponse({ data: [] }))
        .mockRejectedValueOnce({ response: { status: 400 } });

      const ok = await service.addLinks(['http://a'], 'Movie');
      expect(ok).toBe('error');
    });

    it('returns "offline" and pulls the package when every link is dead', async () => {
      await primeConnected(service);
      (service as any).deadLinkBudgetMs = 5000;
      (service as any).deadLinkPollMs = 0;
      mockedAxios.post
        .mockResolvedValueOnce(deviceResponse({ data: [] }))        // getDownloadPackages (dedup)
        .mockResolvedValueOnce(deviceResponse({ data: [] }))        // getLinkGrabberPackages (dedup)
        .mockResolvedValueOnce(deviceResponse({ data: { id: 1 } })) // addLinks
        .mockResolvedValueOnce(deviceResponse({ data: [{ uuid: 7, name: 'Dead Movie - 1080p', childCount: 3, onlineCount: 0, offlineCount: 3 }] })) // poll #1
        .mockResolvedValueOnce(deviceResponse({ data: [{ uuid: 7, name: 'Dead Movie - 1080p', childCount: 3, onlineCount: 0, offlineCount: 3 }] })) // poll #2 → stable → dead
        .mockResolvedValueOnce(deviceResponse({ data: null }));     // removeLinkGrabberPackages
      const ok = await service.addLinks(['http://a'], 'Dead Movie - 1080p');
      expect(ok).toBe('offline');
    });

    it('returns "sent" when at least one link is online after the check', async () => {
      await primeConnected(service);
      (service as any).deadLinkBudgetMs = 5000;
      (service as any).deadLinkPollMs = 0;
      mockedAxios.post
        .mockResolvedValueOnce(deviceResponse({ data: [] }))
        .mockResolvedValueOnce(deviceResponse({ data: [] }))
        .mockResolvedValueOnce(deviceResponse({ data: { id: 1 } }))
        .mockResolvedValueOnce(deviceResponse({ data: [{ uuid: 8, name: 'Live Movie - 1080p', childCount: 3, onlineCount: 3, offlineCount: 0 }] })); // poll → online
      const ok = await service.addLinks(['http://a'], 'Live Movie - 1080p');
      expect(ok).toBe('sent');
    });
  });
});
