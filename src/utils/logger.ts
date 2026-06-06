import winston from 'winston';
import path from 'path';
import fs from 'fs';

const LOG_DIR = path.join(__dirname, '../../logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

/**
 * Extra arguments after the message — `logger.error('Route failed:', err.message,
 * err.stack)` — used to vanish: without a splat step winston keeps them under a
 * symbol the printf below never sees, so the log said "Route failed:" and
 * nothing else, on exactly the paths where the detail mattered. Plain values
 * are appended to the message; objects stay metadata as before.
 */
const appendExtraArgs = winston.format(info => {
  const extras = (info as any)[Symbol.for('splat')] as unknown[] | undefined;
  if (Array.isArray(extras) && extras.length > 0) {
    const plain = extras.filter(a => a === null || typeof a !== 'object');
    if (plain.length > 0) info.message = `${info.message} ${plain.map(a => String(a)).join(' ')}`;
  }
  return info;
});

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    appendExtraArgs(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...rest }) => {
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      return `${timestamp} [${level.toUpperCase()}] ${message}${extra}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...rest }) => {
          const meta = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
          return `${timestamp} ${level}: ${message}${meta}`;
        })
      ),
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
});
