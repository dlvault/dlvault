import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/jdownloader/index', () => ({
  jdownloaderService: { listAccounts: vi.fn() },
}));
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry: vi.fn() }));
vi.mock('../../src/services/telegram', () => ({ sendTelegramAdminAlert: vi.fn() }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { jdownloaderService } from '../../src/jdownloader/index';
import { addLogEntry } from '../../src/database/services/activityLog';
import { sendTelegramAdminAlert } from '../../src/services/telegram';
import { checkHosterAccounts, classifyAccount, getHosterAccountIssues, _resetHosterAccountState } from '../../src/services/hosterAccounts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

function rg(validUntil: number, extra: Record<string, unknown> = {}) {
  return { uuid: 1, hostname: 'hoster-a.example', username: 'x', enabled: true, valid: true, validUntil, ...extra };
}

describe('classifyAccount', () => {
  it('ok when expiry is far out or unknown', () => {
    expect(classifyAccount(rg(NOW + 180 * DAY), NOW)).toBe('ok');
    expect(classifyAccount(rg(-1), NOW)).toBe('ok');
  });
  it('expiring inside the 7-day window, expired once past', () => {
    expect(classifyAccount(rg(NOW + 3 * DAY), NOW)).toBe('expiring');
    expect(classifyAccount(rg(NOW - DAY), NOW)).toBe('expired');
  });
  it('error when JD marks the login invalid; disabled accounts are ignored', () => {
    expect(classifyAccount(rg(NOW + 100 * DAY, { valid: false, errorType: 'INVALID' }), NOW)).toBe('error');
    expect(classifyAccount(rg(NOW - DAY, { enabled: false }), NOW)).toBe('ok');
  });
});

describe('checkHosterAccounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetHosterAccountState();
  });

  it('alerts the owner once when the premium has expired (JD silently in free mode)', async () => {
    vi.mocked(jdownloaderService.listAccounts).mockResolvedValue([rg(Date.UTC(2026, 8, 15))] as any);

    await checkHosterAccounts(NOW, true);
    await checkHosterAccounts(NOW + DAY, true);

    expect(sendTelegramAdminAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTelegramAdminAlert).mock.calls[0][0]).toContain('hoster-a.example-Premium abgelaufen');
    expect(addLogEntry).toHaveBeenCalledWith(null, 'hoster_account', expect.stringContaining('abgelaufen'));
  });

  it('reminds again after 3 days while it stays expired', async () => {
    vi.mocked(jdownloaderService.listAccounts).mockResolvedValue([rg(NOW - DAY)] as any);

    await checkHosterAccounts(NOW, true);
    await checkHosterAccounts(NOW + 3 * DAY, true);

    expect(sendTelegramAdminAlert).toHaveBeenCalledTimes(2);
  });

  it('warns ahead of expiry, then reports the renewal', async () => {
    vi.mocked(jdownloaderService.listAccounts).mockResolvedValueOnce([rg(NOW + 2 * DAY)] as any);
    await checkHosterAccounts(NOW, true);
    expect(vi.mocked(sendTelegramAdminAlert).mock.calls[0][0]).toContain('läuft bald ab');

    vi.mocked(jdownloaderService.listAccounts).mockResolvedValueOnce([rg(NOW + 180 * DAY)] as any);
    await checkHosterAccounts(NOW + DAY, true);
    expect(vi.mocked(sendTelegramAdminAlert).mock.calls[1][0]).toContain('wieder aktiv');
  });

  it('stays quiet for a healthy account and throttles to every 6 h', async () => {
    vi.mocked(jdownloaderService.listAccounts).mockResolvedValue([rg(NOW + 180 * DAY)] as any);

    await checkHosterAccounts(NOW);
    await checkHosterAccounts(NOW + 60 * 60 * 1000);

    expect(jdownloaderService.listAccounts).toHaveBeenCalledTimes(1);
    expect(sendTelegramAdminAlert).not.toHaveBeenCalled();
    expect(addLogEntry).not.toHaveBeenCalled();
  });

  it('retries next tick when JD is unreachable', async () => {
    vi.mocked(jdownloaderService.listAccounts).mockResolvedValueOnce(null);
    await checkHosterAccounts(NOW);
    vi.mocked(jdownloaderService.listAccounts).mockResolvedValueOnce([rg(NOW - DAY)] as any);
    await checkHosterAccounts(NOW + 5 * 60 * 1000);

    expect(sendTelegramAdminAlert).toHaveBeenCalledTimes(1);
  });

  it('exposes the open problem for the dashboard banner and clears it after renewal', async () => {
    const expiredAt = Date.UTC(2026, 8, 15);
    vi.mocked(jdownloaderService.listAccounts).mockResolvedValueOnce([rg(expiredAt)] as any);
    await checkHosterAccounts(NOW, true);
    expect(getHosterAccountIssues()).toEqual([
      expect.objectContaining({ hostname: 'hoster-a.example', state: 'expired', validUntil: expiredAt }),
    ]);

    // While a problem stands it re-checks after 30 min, not 6 h — so the banner
    // goes away soon after the owner renews.
    vi.mocked(jdownloaderService.listAccounts).mockResolvedValueOnce([rg(NOW + 180 * DAY)] as any);
    await checkHosterAccounts(NOW + 31 * 60 * 1000);
    expect(getHosterAccountIssues()).toEqual([]);
  });
});
