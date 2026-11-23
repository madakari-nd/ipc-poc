import { pino, type Logger } from 'pino';
import { currentCorrelationId } from './http.js';

/** Paths never written to logs (tokens, cookies, passwords, free text, personal data). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-auth-token"]',
  'req.headers["x-csrf-token"]',
  'req.headers["internal-access-token"]',
  'req.headers["x-scheduler-secret"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.access_token',
  '*.refresh_token',
  '*.reasonText',
  '*.problem',
  '*.notes',
];

/** Structured JSON logger; every line carries the current correlationId (Constitution VI). */
export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service, profile: process.env.IPC_PROFILE },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    mixin: () => {
      const correlationId = currentCorrelationId();
      return correlationId ? { correlationId } : {};
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type { Logger };
