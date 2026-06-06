import { jdownloaderService, type JDAccount } from '../jdownloader/index';
import { addLogEntry } from '../database/services/activityLog';
import { logger } from '../utils/logger';

// Watches the hoster premium accounts configured in JDownloader and warns the
// owner before and when one runs out. An expired premium is silent otherwise:
// JD falls back to free mode (a long wait per part, one file at a time) and
// downloads crawl for weeks before anyone notices.

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;      // JD only refreshes account info a few times a day
const ISSUE_CHECK_INTERVAL_MS = 30 * 60 * 1000;    // while a problem stands, notice the renewal quickly so the banner clears
const WARN_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;    // heads-up a week ahead
const REMIND_EXPIRED_MS = 3 * 24 * 60 * 60 * 1000; // an ignored expiry is exactly what went wrong — nag every 3 days

export type AccountState = 'ok' | 'expiring' | 'expired' | 'error';

interface Alerted { state: AccountState; at: number }

export interface HosterAccountIssue {
  hostname: string;
  state: Exclude<AccountState, 'ok'>;
  validUntil: number | null;
  message: string;
}

let lastCheckAt = 0;
const alerted = new Map<number, Alerted>();
let currentIssues: HosterAccountIssue[] = [];

/** Problem accounts as of the last check — read by the dashboard banner (no live JD call). */
export function getHosterAccountIssues(): HosterAccountIssue[] {
  return currentIssues;
}

/** Test helper — reset throttle + per-account alert memory. */
export function _resetHosterAccountState(): void {
  lastCheckAt = 0;
  alerted.clear();
  currentIssues = [];
}

export function classifyAccount(acc: JDAccount, now: number): AccountState {
  if (acc.enabled === false) return 'ok'; // switched off on purpose
  if (acc.valid === false || acc.errorType) return 'error';
  const until = acc.validUntil ?? -1;
  if (until <= 0) return 'ok'; // no expiry known (lifetime/free/unknown)
  if (until < now) return 'expired';
  if (until - now < WARN_BEFORE_MS) return 'expiring';
  return 'ok';
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: process.env.TZ || 'Europe/Berlin' });
}

function message(acc: JDAccount, state: AccountState, now: number): { log: string; telegram: string } {
  const host = acc.hostname;
  const until = acc.validUntil ?? 0;
  switch (state) {
    case 'expiring': {
      const days = Math.max(1, Math.ceil((until - now) / (24 * 60 * 60 * 1000)));
      return {
        log: `${host}: Premium läuft am ${formatDate(until)} ab (noch ${days} Tag${days === 1 ? '' : 'e'})`,
        telegram: `⏳ <b>${host}-Premium läuft bald ab</b>\nNoch ${days} Tag${days === 1 ? '' : 'e'} (bis ${formatDate(until)}). `
          + 'Danach lädt JDownloader nur noch im Free-Modus — langsam und mit Wartezeit pro Teil.',
      };
    }
    case 'expired':
      return {
        log: `${host}: Premium seit ${formatDate(until)} abgelaufen — JDownloader lädt im Free-Modus`,
        telegram: `⚠️ <b>${host}-Premium abgelaufen</b>\nSeit ${formatDate(until)}. JDownloader lädt jetzt nur noch im Free-Modus `
          + '(lange Wartezeiten, ein Teil nach dem anderen). Bitte Premium verlängern.',
      };
    case 'error': {
      const why = acc.errorString || acc.errorType || 'ungültig';
      return {
        log: `${host}: Account-Problem in JDownloader (${why})`,
        telegram: `⚠️ <b>${host}-Account hat ein Problem</b>\nJDownloader meldet: ${why}. Bitte die Zugangsdaten in JDownloader prüfen.`,
      };
    }
    default:
      return {
        log: `${host}: Premium wieder aktiv${until > 0 ? ` (bis ${formatDate(until)})` : ''}`,
        telegram: `✅ <b>${host}-Premium wieder aktiv</b>${until > 0 ? `\nGültig bis ${formatDate(until)}.` : ''}`,
      };
  }
}

/**
 * Check JD's hoster accounts and alert on state changes. Throttled to every 6 h
 * unless forced; called from the JD monitor once JD is known reachable.
 */
export async function checkHosterAccounts(now = Date.now(), force = false): Promise<void> {
  const interval = currentIssues.length > 0 ? ISSUE_CHECK_INTERVAL_MS : CHECK_INTERVAL_MS;
  if (!force && now - lastCheckAt < interval) return;
  const accounts = await jdownloaderService.listAccounts();
  if (!accounts) return; // JD unreachable — try again next tick
  lastCheckAt = now;

  const issues: HosterAccountIssue[] = [];
  for (const acc of accounts) {
    const state = classifyAccount(acc, now);
    if (state !== 'ok') {
      issues.push({
        hostname: acc.hostname,
        state,
        validUntil: acc.validUntil && acc.validUntil > 0 ? acc.validUntil : null,
        message: message(acc, state, now).log,
      });
    }
  }
  currentIssues = issues;

  for (const acc of accounts) {
    const state = classifyAccount(acc, now);
    const prev = alerted.get(acc.uuid);

    let notify = false;
    if (state === 'ok') {
      // Only worth a message when it recovers from a problem we reported.
      notify = !!prev && prev.state !== 'ok';
    } else if (!prev || prev.state !== state) {
      notify = true;
    } else if (state === 'expired' && now - prev.at >= REMIND_EXPIRED_MS) {
      notify = true;
    }

    if (!notify) {
      if (!prev && state === 'ok') alerted.set(acc.uuid, { state, at: now });
      continue;
    }
    alerted.set(acc.uuid, { state, at: now });

    const { log, telegram } = message(acc, state, now);
    if (state === 'ok') logger.info(`Hoster account: ${log}`);
    else logger.warn(`Hoster account: ${log}`);
    addLogEntry(null, 'hoster_account', log);
    try {
      const { sendTelegramAdminAlert } = await import('./telegram');
      await sendTelegramAdminAlert(telegram);
    } catch (err: any) {
      logger.error(`Failed to send hoster-account alert to Telegram: ${err.message}`);
    }
  }
}
