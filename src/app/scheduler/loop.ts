import { setTimeout } from 'node:timers/promises';

export interface ProductionResult {
  reminders: number;
  executions: number;
  blockedRules: number;
}

/** Serial ticks; stop interrupts idle wait and drains the current transaction. */
export function startScheduler(
  producer: { tick(now: string): Promise<ProductionResult> },
  pollMs: number,
  report: (event: 'scheduler.failed' | 'scheduler.catch_up_blocked') => void,
  clock = () => new Date().toISOString(),
) {
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 2_147_483_647)
    throw new RangeError('Invalid poll interval');
  const controller = new AbortController();
  const done = (async () => {
    while (!controller.signal.aborted) {
      try {
        const result = await producer.tick(clock());
        if (result.blockedRules) report('scheduler.catch_up_blocked');
      } catch {
        report('scheduler.failed');
      }
      if (!controller.signal.aborted) {
        try {
          await setTimeout(pollMs, undefined, { signal: controller.signal });
        } catch {
          /* Shutdown interrupts the wait. */
        }
      }
    }
  })();
  return {
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}
