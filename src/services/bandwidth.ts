import { getSetting } from '../database/index';
import { jdownloaderService } from '../jdownloader/index';
import { logger } from '../utils/logger';

let intervalId: ReturnType<typeof setInterval> | null = null;
let lastAppliedLimit: number | null = null;

function isEnabled(): boolean {
  return getSetting('bandwidth.schedule_enabled') === 'true';
}

function isDayTime(): boolean {
  const now = new Date();
  const hour = now.getHours();
  const dayStart = parseInt(getSetting('bandwidth.day_start') || '8', 10);
  const dayEnd = parseInt(getSetting('bandwidth.day_end') || '23', 10);
  // Support a daytime window that wraps past midnight (e.g. day_start=22,
  // day_end=6). Without this, dayStart > dayEnd makes the condition always
  // false → the night limit is applied 24/7.
  return dayStart <= dayEnd
    ? (hour >= dayStart && hour < dayEnd)
    : (hour >= dayStart || hour < dayEnd);
}

export async function checkAndApplyLimit(): Promise<void> {
  if (!isEnabled()) return;
  if (!jdownloaderService.isConfigured()) return;

  const dayLimitKbps = parseInt(getSetting('bandwidth.day_limit_kbps') || '5000', 10);
  const nightLimitKbps = parseInt(getSetting('bandwidth.night_limit_kbps') || '0', 10);

  const targetLimit = isDayTime() ? dayLimitKbps : nightLimitKbps;

  // Skip if the limit hasn't changed since last apply
  if (targetLimit === lastAppliedLimit) return;

  try {
    const connected = await jdownloaderService.connect();
    if (!connected) return;

    if (targetLimit === 0) {
      // Unlimited — disable speed limiter
      await jdownloaderService.setSpeedLimitEnabled(false);
      logger.info('Bandwidth scheduler: speed limit disabled (unlimited)');
    } else {
      await jdownloaderService.setSpeedLimit(targetLimit);
      await jdownloaderService.setSpeedLimitEnabled(true);
      logger.info(`Bandwidth scheduler: speed limit set to ${targetLimit} KB/s`);
    }

    lastAppliedLimit = targetLimit;
  } catch (err: any) {
    logger.error(`Bandwidth scheduler error: ${err.message}`);
  }
}

export function startBandwidthScheduler(): void {
  stopBandwidthScheduler();

  if (!isEnabled()) {
    logger.info('Bandwidth scheduler is disabled');
    return;
  }

  logger.info('Bandwidth scheduler started (checking every 5 minutes)');

  // Run immediately, then every 5 minutes
  checkAndApplyLimit();
  intervalId = setInterval(checkAndApplyLimit, 5 * 60 * 1000);
}

export function stopBandwidthScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    lastAppliedLimit = null;
    logger.info('Bandwidth scheduler stopped');
  }
}

export function restartBandwidthScheduler(): void {
  lastAppliedLimit = null;
  startBandwidthScheduler();
}
