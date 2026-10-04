import { setTimeout } from 'node:timers/promises';
import type { Pool } from 'pg';

/** Session lock serializes polling across an old/new deployment overlap. */
export async function pollingLease(
  pool: Pool,
  botId: number,
  signal: AbortSignal,
  lost: () => void,
) {
  const db = await pool.connect();
  const key = `telegram-poller:${botId}`;
  let broken = false;
  let acquired = false;
  const onError = () => {
    broken = true;
    lost();
  };
  db.on('error', onError);
  try {
    while (!signal.aborted) {
      acquired = (
        await db.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
          [key],
        )
      ).rows[0]!.locked;
      if (acquired) break;
      await setTimeout(500, undefined, { signal });
    }
    if (!acquired) throw new Error('Polling lease cancelled');
  } catch (error) {
    db.removeListener('error', onError);
    db.release(broken);
    throw error;
  }
  return async () => {
    try {
      if (!broken)
        await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
          key,
        ]);
    } catch {
      broken = true;
    } finally {
      db.removeListener('error', onError);
      db.release(broken);
    }
  };
}
