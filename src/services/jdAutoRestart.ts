import fs from 'node:fs';
import { getSetting } from '../database/index';
import { addLogEntry } from '../database/services/activityLog';
import { dockerRequest } from '../utils/docker';
import { logger } from '../utils/logger';

/**
 * Restart the JDownloader container when it has dropped off MyJDownloader.
 *
 * A JD that starts before the network is up (host reboot) never registers its
 * device, and stays that way: 8 days without a download after 2026-09-30, 11.5
 * hours on 2026-10-11. Restarting the container is the known fix, and dlvault
 * already holds the docker socket for its updater.
 *
 * Deliberately narrow:
 *  - only on `device_missing` (MyJD login works, no device) — never on a relay
 *    outage, which a restart cannot fix;
 *  - only after 15 minutes of it, at most once an hour;
 *  - only the container NAMED in jdownloader.container_name (empty = off), which
 *    must exist and must not be dlvault itself. No guessing.
 */

export const MISSING_BEFORE_RESTART_MS = 15 * 60 * 1000;
export const RESTART_COOLDOWN_MS = 60 * 60 * 1000;

let missingSince: number | null = null;
let lastRestartAt = Number.NEGATIVE_INFINITY;   // never

export function _resetJdAutoRestart(): void { missingSince = null; lastRestartAt = Number.NEGATIVE_INFINITY; }

export type ProbeState = 'ok' | 'relay_unreachable' | 'device_missing';
export type RestartOutcome =
  | { action: 'none' }
  | { action: 'restarted'; container: string }
  | { action: 'refused'; reason: string };

const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** Restart a container by exact name; refuses unknown names and dlvault's own container. */
export async function restartContainer(name: string): Promise<{ ok: boolean; detail: string }> {
  if (!VALID_NAME.test(name)) return { ok: false, detail: `ungültiger Container-Name "${name}"` };
  const inspect = await dockerRequest<{ Id?: string; Name?: string }>('GET', `/containers/${encodeURIComponent(name)}/json`);
  if (inspect.status === 404) return { ok: false, detail: `Container "${name}" existiert nicht` };
  if (inspect.status !== 200 || typeof inspect.body !== 'object') return { ok: false, detail: `Docker antwortet ${inspect.status}` };
  let self = '';
  try { self = fs.readFileSync('/etc/hostname', 'utf8').trim(); } catch { /* not in a container */ }
  if (self && inspect.body.Id?.startsWith(self)) return { ok: false, detail: 'das ist dlvaults eigener Container' };
  const res = await dockerRequest('POST', `/containers/${encodeURIComponent(name)}/restart?t=30`);
  if (res.status === 204) return { ok: true, detail: 'neu gestartet' };
  return { ok: false, detail: `Neustart abgelehnt (HTTP ${res.status})` };
}

/**
 * Feed every JD monitor probe in. Restarts at most once an hour after fifteen
 * minutes of `device_missing`; anything else resets the clock.
 */
export async function onJdProbe(
  state: ProbeState,
  now = Date.now(),
  deps: {
    restart: (name: string) => Promise<{ ok: boolean; detail: string }>;
    notify: (text: string) => void;
  } = {
    restart: restartContainer,
    notify: (text) => {
      import('./telegram')
        .then(({ sendTelegramSystemAlert }) => sendTelegramSystemAlert(text))
        .catch(() => { /* best effort */ });
    },
  },
): Promise<RestartOutcome> {
  if (state !== 'device_missing') {
    if (state === 'ok' && missingSince !== null && lastRestartAt > missingSince - MISSING_BEFORE_RESTART_MS) {
      logger.info('JD auto-restart: device registered again');
    }
    missingSince = null;
    return { action: 'none' };
  }
  if (missingSince === null) missingSince = now;
  if (now - missingSince < MISSING_BEFORE_RESTART_MS) return { action: 'none' };

  const name = (getSetting('jdownloader.container_name') || '').trim();
  if (!name) return { action: 'none' };                               // feature off
  if (now - lastRestartAt < RESTART_COOLDOWN_MS) return { action: 'none' };

  lastRestartAt = now;
  missingSince = now;                                                 // give the restart its own 15 minutes
  let result: { ok: boolean; detail: string };
  try {
    result = await deps.restart(name);
  } catch (err: any) {
    result = { ok: false, detail: err?.message || String(err) };
  }
  if (!result.ok) {
    logger.warn(`JD auto-restart: refused for "${name}" — ${result.detail}`);
    addLogEntry(null, 'jd_restart_failed', `JDownloader-Neustart nicht möglich: ${result.detail}`);
    deps.notify(`⚠️ <b>JDownloader</b>\nJD ist seit über 15 Minuten nicht bei MyJDownloader angemeldet, der automatische Neustart ging nicht: ${result.detail}. Bitte JD von Hand neu starten.`);
    return { action: 'refused', reason: result.detail };
  }
  logger.warn(`JD auto-restart: container "${name}" restarted (no MyJDownloader device for 15+ min)`);
  addLogEntry(null, 'jd_restarted', `JDownloader-Container "${name}" automatisch neu gestartet — war nicht bei MyJDownloader angemeldet`);
  deps.notify(`🔄 <b>JDownloader neu gestartet</b>\nJD war seit über 15 Minuten nicht bei MyJDownloader angemeldet. dlvault hat den Container „${name}“ neu gestartet; Downloads laufen danach automatisch weiter.`);
  return { action: 'restarted', container: name };
}
