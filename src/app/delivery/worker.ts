import { setTimeout } from 'node:timers/promises';
import type { ContentKind } from '../../domain/content/archive.js';
import {
  retryAt,
  type DeliveryFailure,
  type DeliveryRepository,
  type DeliveryUnit,
} from './model.js';

export interface DeliveryTransport {
  check(
    ownerId: string,
    targetId: string,
    kinds: ContentKind[],
  ): Promise<{ id: string; chatId: string; title: string }>;
  copy(chatId: string, unit: DeliveryUnit): Promise<number[]>;
  classify(error: unknown, sending: boolean): DeliveryFailure;
  unavailable(ownerId: string, targetId: string): Promise<void>;
}
export class DeliveryWorker {
  constructor(
    private readonly repository: DeliveryRepository,
    private readonly transport: DeliveryTransport,
    private readonly maxAttempts = 5,
    private readonly clock = () => new Date().toISOString(),
    private readonly random = Math.random,
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
      throw new RangeError('Invalid max attempts');
  }
  runOne() {
    return this.repository.runNext(this.clock(), async (session) => {
      if (!session.units.length) {
        await session.fail(
          null,
          { state: 'FAILED_PERMANENT', code: 'EMPTY_PACKAGE' },
          null,
        );
        return;
      }
      const pending = session.units.filter((u) => u.state !== 'SENT');
      if (!pending.length) {
        await session.complete();
        return;
      }
      const fail = async (
        unit: DeliveryUnit | null,
        error: unknown,
        sending: boolean,
      ) => {
        const failure = this.transport.classify(error, sending);
        const attempts = unit ? unit.attempts : session.attempts;
        if (
          failure.state === 'FAILED_RETRYABLE' &&
          attempts >= this.maxAttempts
        ) {
          failure.state = 'FAILED_PERMANENT';
          failure.code = 'ATTEMPTS_EXHAUSTED';
        }
        const next =
          failure.state === 'FAILED_RETRYABLE'
            ? retryAt(this.clock(), attempts, failure.retryAfter, this.random)
            : null;
        await session.fail(unit, failure, next);
        if (failure.targetUnavailable)
          await this.transport.unavailable(session.ownerId, session.targetId);
      };
      let target: { id: string; chatId: string; title: string };
      try {
        target = await this.transport.check(
          session.ownerId,
          session.targetId,
          pending.flatMap((u) => u.kinds),
        );
      } catch (error) {
        await fail(null, error, false);
        return;
      }
      if (!(await session.destination(target))) return;
      for (const unit of pending) {
        if (unit.attempts >= this.maxAttempts) {
          await session.fail(
            unit,
            { state: 'FAILED_PERMANENT', code: 'ATTEMPTS_EXHAUSTED' },
            null,
          );
          return;
        }
        // A committed intent precedes every network send. Persistence errors escape, never become a retryable copy failure.
        await session.sending(unit, target.chatId);
        let ids: number[];
        try {
          ids = await this.transport.copy(target.chatId, unit);
        } catch (error) {
          await fail(unit, error, true);
          return;
        }
        await session.sent(unit, ids);
      }
      await session.complete();
    });
  }
}

export function startDeliveryWorkers(
  worker: Pick<DeliveryWorker, 'runOne'>,
  concurrency: number,
  report: () => void,
  pollMs = 1000,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new RangeError('Invalid concurrency');
  const controller = new AbortController();
  const loops = Array.from({ length: concurrency }, async () => {
    while (!controller.signal.aborted) {
      let worked = false;
      try {
        worked = await worker.runOne();
      } catch {
        report();
      }
      if (!worked && !controller.signal.aborted) {
        try {
          await setTimeout(pollMs, undefined, { signal: controller.signal });
        } catch {
          /* stopping */
        }
      }
    }
  });
  return {
    stop: async () => {
      controller.abort();
      await Promise.all(loops);
    },
  };
}
