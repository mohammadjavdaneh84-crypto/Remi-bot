import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgDeliveryRepository } from '../../src/infrastructure/db/deliveries.js';
import { PgScheduleProducer } from '../../src/infrastructure/db/scheduler.js';
import { DeliveryWorker } from '../../src/app/delivery/worker.js';
import { classifyDelivery } from '../../src/infrastructure/telegram/delivery.js';
import { databaseUrl, withDatabase } from '../helpers/database.js';
import { seedManaged, managementNow as now } from '../helpers/management.js';
const options = { skip: !databaseUrl };

for (const boundary of ['SENDING', 'SENT'] as const)
  test(
    `terminated PostgreSQL session at ${boundary} safely recovers with a new worker`,
    options,
    async () => {
      await withDatabase(async (pool, owner) => {
        const data = await seedManaged(pool, owner);
        await new PgScheduleProducer(pool).tick(now);
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        const ready = new Promise<void>((r) => {
          entered = r;
        });
        const old = new PgDeliveryRepository(pool).runNext(now, async (s) => {
          await s.sending(s.units[0]!, '-2001');
          if (boundary === 'SENT') await s.sent(s.units[0]!, [501]);
          entered();
          await gate;
          await s.complete();
        });
        const rejected = assert.rejects(old);
        await ready;
        const held = await pool.query<{ pid: number }>(
          `SELECT DISTINCT pid FROM pg_locks l JOIN
        (SELECT hashtextextended('delivery:' || id::text,0) AS key FROM deliveries) d
        ON l.classid::bigint=((d.key >> 32) & 4294967295) AND l.objid::bigint=(d.key & 4294967295)
        WHERE locktype='advisory' AND granted AND pid<>pg_backend_pid()`,
        );
        assert.equal(held.rowCount, 1);
        await pool.query('SELECT pg_terminate_backend($1)', [
          held.rows[0]!.pid,
        ]);
        release();
        await rejected;
        const copied: number[][] = [];
        const worker = new DeliveryWorker(
          new PgDeliveryRepository(pool),
          {
            check: async () => ({
              id: data.target.id,
              chatId: '-2001',
              title: 'Target',
            }),
            copy: async (_chat, unit) => {
              copied.push(unit.messageIds);
              return [502];
            },
            classify: classifyDelivery,
            unavailable: async () => {},
          },
          5,
          () => now,
        );
        await worker.runOne();
        assert.deepEqual(copied, boundary === 'SENT' ? [[102]] : []);
        assert.equal(
          (await pool.query('SELECT state FROM deliveries')).rows[0].state,
          boundary === 'SENT' ? 'SUCCEEDED' : 'UNKNOWN',
        );
        assert.equal(await worker.runOne(), false);
      });
    },
  );

test(
  'log sink failure cannot interrupt sending or expose payloads',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const data = await seedManaged(pool, owner);
      await new PgScheduleProducer(pool).tick(now);
      const events: unknown[] = [];
      const worker = new DeliveryWorker(
        new PgDeliveryRepository(pool, (e) => {
          events.push(e);
          throw new Error('sink offline');
        }),
        {
          check: async () => ({
            id: data.target.id,
            chatId: '-2001',
            title: 'PRIVATE_TITLE',
          }),
          copy: async () => [501],
          classify: classifyDelivery,
          unavailable: async () => {},
        },
        5,
        () => now,
      );
      await worker.runOne();
      assert.equal(
        (await pool.query('SELECT state FROM deliveries')).rows[0].state,
        'SUCCEEDED',
      );
      const json = JSON.stringify(events);
      assert.match(json, /delivery.item.sent/);
      assert.match(json, /delivery_id/);
      assert.doesNotMatch(json, /PRIVATE_TITLE|-2001|storage|token/);
    });
  },
);
