import { z } from 'zod';
import { timezoneSchema } from '../../domain/schedule/rule.js';

const id = z
  .string()
  .regex(/^-?[1-9]\d*$/)
  .refine((v) => {
    const n = BigInt(v);
    return n >= -(2n ** 63n) && n < 2n ** 63n;
  });
const schema = z.object({
  BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/),
  OWNER_TELEGRAM_USER_ID: id.refine((v) => BigInt(v) > 0n),
  STORAGE_CHAT_ID: id.refine((v) => BigInt(v) < 0n),
  DATABASE_URL: z
    .url()
    .refine((v) => ['postgres:', 'postgresql:'].includes(new URL(v).protocol)),
  DEFAULT_TIMEZONE: timezoneSchema.default('Asia/Tehran'),
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_VERSION: z.string().trim().min(1).max(128).default('dev'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  SCHEDULER_POLL_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .default(5000),
  DELIVERY_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  MAX_DELIVERY_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
  MAX_CATCH_UP_EXECUTIONS_PER_RULE: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(10),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid environment fields: ${[...new Set(result.error.issues.map((i) => i.path.join('.')))].join(', ')}`,
    );
  return result.data;
}
