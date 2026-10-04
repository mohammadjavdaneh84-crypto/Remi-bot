import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './infrastructure/config/env.js';
import { createLogger } from './infrastructure/logging/logger.js';
import { createPool } from './infrastructure/db/pool.js';
import { migrate } from './infrastructure/db/migrations.js';
import { createBot } from './infrastructure/telegram/bot.js';
import { healthServer } from './health/server.js';
import { Targets } from './app/services/targets.js';
import { PgTargetRepository } from './infrastructure/db/targets.js';
import { TelegramTargetInspector } from './infrastructure/telegram/targets.js';
import { verifyStorage } from './infrastructure/telegram/storage/verify.js';
import { contentKinds } from './domain/content/archive.js';
import { CreationWizard } from './app/wizard/service.js';
import { PgWizardRepository } from './infrastructure/db/wizard.js';
import { PgArchiveRepository } from './infrastructure/db/archives.js';
import { ContentCapture } from './infrastructure/telegram/storage/capture.js';
import type { Message } from 'grammy/types';
import { PgScheduleProducer } from './infrastructure/db/scheduler.js';
import { startScheduler } from './app/scheduler/loop.js';
import { DeliveryWorker, startDeliveryWorkers } from './app/delivery/worker.js';
import { PgDeliveryRepository } from './infrastructure/db/deliveries.js';
import { TelegramDeliveryTransport } from './infrastructure/telegram/delivery.js';
import { PgHistoryRepository } from './infrastructure/db/history.js';
import { PgManagementRepository } from './infrastructure/db/management.js';
import { PgDailyHeaders } from './infrastructure/db/daily-headers.js';
import { PgDailyHeaderWorker } from './infrastructure/db/daily-header-worker.js';
import { TelegramHeaderTransport } from './infrastructure/telegram/daily-header-transport.js';
import { pollingLease } from './infrastructure/db/polling-lease.js';

export function startupFailure(error: unknown): {
  cause: string;
  fields?: string[];
  telegram_error_code?: number;
  database_error_code?: string;
} {
  if (
    error instanceof Error &&
    error.message.startsWith('Invalid environment fields: ')
  )
    return {
      cause: 'INVALID_CONFIG',
      fields: error.message
        .slice('Invalid environment fields: '.length)
        .split(', ')
        .filter(Boolean),
    };
  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      error_code?: unknown;
      code?: unknown;
    };
    if (typeof candidate.error_code === 'number')
      return {
        cause: 'TELEGRAM_API_ERROR',
        telegram_error_code: candidate.error_code,
      };
    if (
      typeof candidate.code === 'string' &&
      /^[0-9A-Z_]{2,20}$/.test(candidate.code)
    )
      return {
        cause: 'DATABASE_OR_NETWORK_ERROR',
        database_error_code: candidate.code,
      };
  }
  return { cause: 'UNKNOWN_STARTUP_ERROR' };
}

export async function main() {
  const config = loadConfig(process.env);
  const log = createLogger(config.LOG_LEVEL);
  const pool = createPool(config.DATABASE_URL, config.DELIVERY_CONCURRENCY + 6);
  pool.on('error', () => log.error({ event: 'db.pool_error' }));
  let bot: ReturnType<typeof createBot> | undefined;
  let ready = false;
  let scheduler: ReturnType<typeof startScheduler> | undefined;
  let deliveries: ReturnType<typeof startDeliveryWorkers> | undefined;
  let headers: ReturnType<typeof startDeliveryWorkers> | undefined;
  const lifecycle = new AbortController();
  let releasePolling: (() => Promise<void>) | undefined;
  let acquiringPolling: Promise<() => Promise<void>> | undefined;
  const server = healthServer(async () => {
    if (!ready) return false;
    await pool.query('SELECT 1');
    return true;
  }, config.APP_VERSION);
  let stopping = false;
  let shutdown: Promise<void> | undefined;
  function stop(): Promise<void> {
    if (shutdown) return shutdown;
    stopping = true;
    lifecycle.abort();
    ready = false;
    shutdown = (async () => {
      try {
        if (bot?.isRunning()) await bot.stop();
      } finally {
        await scheduler?.stop();
        await deliveries?.stop();
        await headers?.stop();
        if (acquiringPolling) {
          try {
            releasePolling = await acquiringPolling;
          } catch {
            /* Cancelled while waiting for old deployment. */
          }
        }
        await releasePolling?.();
        if (server.listening)
          await new Promise<void>((resolve) => server.close(() => resolve()));
        await pool.end();
      }
    })();
    return shutdown;
  }
  const signal = () => {
    void stop().catch(() => {
      log.error({ event: 'app.shutdown_failed' });
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', signal);
  process.once('SIGTERM', signal);
  try {
    await pool.query('SELECT 1');
    // Safe, locked, checksum-verified migrations make a fresh deployment self-contained.
    await migrate(pool);
    await pool.query(
      'INSERT INTO users (id, telegram_user_id, default_timezone) VALUES ($1, $2, $3) ON CONFLICT (telegram_user_id) DO NOTHING',
      [randomUUID(), config.OWNER_TELEGRAM_USER_ID, config.DEFAULT_TIMEZONE],
    );
    const owner = await pool.query<{ id: string }>(
      'SELECT id FROM users WHERE telegram_user_id=$1',
      [config.OWNER_TELEGRAM_USER_ID],
    );
    bot = createBot(
      config.BOT_TOKEN,
      config.OWNER_TELEGRAM_USER_ID,
      (instance) => {
        const targets = new Targets(
          owner.rows[0]!.id,
          new PgTargetRepository(pool),
          new TelegramTargetInspector(instance.api, () => instance.botInfo.id),
        );
        const capture = new ContentCapture(
          instance.api,
          new PgArchiveRepository(pool),
          owner.rows[0]!.id,
          config.OWNER_TELEGRAM_USER_ID,
          config.STORAGE_CHAT_ID,
          () => instance.botInfo.id,
        );
        return {
          dailyHeaders: {
            repository: new PgDailyHeaders(pool),
            ownerId: owner.rows[0]!.id,
            transport: new TelegramHeaderTransport(
              pool,
              instance.api,
              () => instance.botInfo.id,
            ),
            onError: () =>
              log.error({ event: 'daily_header.operation_failed' }),
          },
          management: {
            repository: new PgManagementRepository(pool),
            ownerId: owner.rows[0]!.id,
            onError: () => log.error({ event: 'management.failed' }),
          },
          history: {
            repository: new PgHistoryRepository(pool),
            ownerId: owner.rows[0]!.id,
          },
          storageChatId: config.STORAGE_CHAT_ID,
          targets,
          wizard: new CreationWizard(
            owner.rows[0]!.id,
            new PgWizardRepository(pool),
            targets,
            {
              archive: (payloads) => capture.archiveUnit(payloads as Message[]),
            },
            () => new Date().toISOString(),
            () => log.error({ event: 'wizard.operation_failed' }),
          ),
        };
      },
    );
    await bot.init();
    try {
      await verifyStorage(
        bot.api,
        config.STORAGE_CHAT_ID,
        bot.botInfo.id,
        contentKinds,
      );
    } catch {
      log.warn({ event: 'storage.unavailable' });
    }
    if (stopping) return;
    server.listen(config.PORT, '0.0.0.0');
    await once(server, 'listening');
    if (stopping) return;
    bot.catch(() => log.error({ event: 'telegram.update_failed' }));
    // Ready means initialized and DB reachable, even during the brief deployment handoff.
    // The platform can then stop the old healthy container, releasing its polling lease.
    ready = true;
    acquiringPolling = pollingLease(
      pool,
      bot.botInfo.id,
      lifecycle.signal,
      () => {
        log.error({ event: 'telegram.polling_lease_lost' });
        process.exitCode = 1;
        signal();
      },
    );
    try {
      releasePolling = await acquiringPolling;
    } catch (error) {
      if (stopping) return;
      throw error;
    }
    if (stopping) return;
    log.info({ event: 'app.started' });
    await bot.start({
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      onStart: () => {
        if (stopping) return;
        scheduler = startScheduler(
          new PgScheduleProducer(pool, config.MAX_CATCH_UP_EXECUTIONS_PER_RULE),
          config.SCHEDULER_POLL_MS,
          (event) => log.warn({ event }),
        );
        ready = true;
        headers = startDeliveryWorkers(
          new PgDailyHeaderWorker(
            pool,
            new TelegramHeaderTransport(pool, bot!.api, () => bot!.botInfo.id),
            config.MAX_DELIVERY_ATTEMPTS,
            (event) => log.info(event),
          ),
          1,
          () => log.error({ event: 'daily_header.worker_failed' }),
        );
        deliveries = startDeliveryWorkers(
          new DeliveryWorker(
            new PgDeliveryRepository(pool, (event) => log.info(event)),
            new TelegramDeliveryTransport(
              pool,
              bot!.api,
              () => bot!.botInfo.id,
            ),
            config.MAX_DELIVERY_ATTEMPTS,
          ),
          config.DELIVERY_CONCURRENCY,
          () => log.error({ event: 'delivery.worker_failed' }),
        );
      },
    });
  } finally {
    await stop();
    process.off('SIGINT', signal);
    process.off('SIGTERM', signal);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    createLogger().fatal({
      event: 'app.start_failed',
      ...startupFailure(error),
    });
    process.exitCode = 1;
  });
}
