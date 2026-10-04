import pino from 'pino';

export function createLogger(level: string = 'info') {
  return pino({
    level,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: [
      'token',
      'BOT_TOKEN',
      'DATABASE_URL',
      'content',
      'message',
      'chat_id',
      'req',
      'err',
    ],
  });
}
// Log controlled event codes and safe identifiers only; never serialize Telegram errors/updates.
