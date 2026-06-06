import { describe, it, expect, vi, beforeEach } from 'vitest';

const st = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  docker: vi.fn(),
  logs: [] as string[],
}));
vi.mock('../../src/database/index', () => ({ getSetting: (k: string) => st.settings[k] ?? '' }));
vi.mock('../../src/database/services/activityLog', () => ({ addLogEntry: (_id: any, action: string) => { st.logs.push(action); } }));
vi.mock('../../src/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/utils/docker', () => ({ dockerRequest: st.docker }));
vi.mock('node:fs', async (orig) => {
  const actual: any = await orig();
  const readFileSync = (p: any, ...a: any[]) => (p === '/etc/hostname' ? 'abc123def456\n' : actual.readFileSync(p, ...a));
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

import { onJdProbe, restartContainer, _resetJdAutoRestart, MISSING_BEFORE_RESTART_MS, RESTART_COOLDOWN_MS } from '../../src/services/jdAutoRestart';

const MIN = 60_000;
describe('JD auto-restart — when', () => {
  let restart: ReturnType<typeof vi.fn>; let notify: ReturnType<typeof vi.fn>;
  const deps = () => ({ restart, notify });
  beforeEach(() => {
    _resetJdAutoRestart(); st.logs = [];
    st.settings = { 'jdownloader.container_name': 'JDownloader2' };
    restart = vi.fn(async () => ({ ok: true, detail: 'neu gestartet' })); notify = vi.fn();
  });

  it('restarts only after 15 minutes without a device, then at most once an hour', async () => {
    const t0 = 1_000_000_000;
    expect((await onJdProbe('device_missing', t0, deps())).action).toBe('none');
    expect((await onJdProbe('device_missing', t0 + 10 * MIN, deps())).action).toBe('none');
    expect(await onJdProbe('device_missing', t0 + MISSING_BEFORE_RESTART_MS, deps())).toEqual({ action: 'restarted', container: 'JDownloader2' });
    expect(restart).toHaveBeenCalledWith('JDownloader2');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(st.logs).toEqual(['jd_restarted']);
    // still missing 20 min later: inside the cooldown
    expect((await onJdProbe('device_missing', t0 + MISSING_BEFORE_RESTART_MS + 20 * MIN, deps())).action).toBe('none');
    // after the cooldown, a second try
    expect((await onJdProbe('device_missing', t0 + MISSING_BEFORE_RESTART_MS + RESTART_COOLDOWN_MS, deps())).action).toBe('restarted');
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('never acts on a relay outage, and a healthy probe resets the clock', async () => {
    const t0 = 2_000_000_000;
    await onJdProbe('device_missing', t0, deps());
    await onJdProbe('ok', t0 + 10 * MIN, deps());
    expect((await onJdProbe('device_missing', t0 + 16 * MIN, deps())).action).toBe('none');   // clock restarted
    for (let i = 0; i < 10; i++) await onJdProbe('relay_unreachable', t0 + (20 + i * 5) * MIN, deps());
    expect(restart).not.toHaveBeenCalled();
  });

  it('does nothing without a configured container', async () => {
    st.settings = {};
    await onJdProbe('device_missing', 0, deps());
    expect((await onJdProbe('device_missing', MISSING_BEFORE_RESTART_MS * 4, deps())).action).toBe('none');
    expect(restart).not.toHaveBeenCalled();
  });

  it('reports a refused restart and tells the owner to act', async () => {
    restart = vi.fn(async () => ({ ok: false, detail: 'Container "JDownloader2" existiert nicht' }));
    await onJdProbe('device_missing', 0, deps());
    const out = await onJdProbe('device_missing', MISSING_BEFORE_RESTART_MS, deps());
    expect(out.action).toBe('refused');
    expect(st.logs).toEqual(['jd_restart_failed']);
    expect(notify.mock.calls[0][0]).toContain('von Hand');
  });
});

describe('JD auto-restart — the restart itself', () => {
  beforeEach(() => { st.docker.mockReset(); });

  it('restarts an existing container by exact name', async () => {
    st.docker.mockImplementation(async (m: string, p: string) =>
      m === 'GET' ? { status: 200, body: { Id: 'fff000111222' } } : { status: 204, body: '' });
    expect(await restartContainer('JDownloader2')).toEqual({ ok: true, detail: 'neu gestartet' });
    expect(st.docker).toHaveBeenLastCalledWith('POST', '/containers/JDownloader2/restart?t=30');
  });

  it('refuses unknown names, odd names and dlvault itself', async () => {
    st.docker.mockResolvedValueOnce({ status: 404, body: '' });
    expect((await restartContainer('Nope')).ok).toBe(false);
    expect((await restartContainer('../containers/x')).ok).toBe(false);
    expect((await restartContainer('a b')).ok).toBe(false);
    st.docker.mockResolvedValueOnce({ status: 200, body: { Id: 'abc123def456789' } });   // matches /etc/hostname
    const self = await restartContainer('dlvault');
    expect(self).toEqual({ ok: false, detail: 'das ist dlvaults eigener Container' });
    expect(st.docker).not.toHaveBeenCalledWith('POST', expect.anything());
  });
});
