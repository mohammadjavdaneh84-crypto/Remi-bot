import { z } from 'zod';
import { ruleSchema, timezoneSchema } from '../../domain/schedule/rule.js';
import { contentKinds } from '../../domain/content/archive.js';

export const draftSchema = z.object({
  name: z.string().max(100),
  timezone: timezoneSchema,
  missedPolicy: z.enum(['LATEST_ONLY', 'SKIP', 'CATCH_UP']).optional(),
  archives: z
    .array(
      z.object({
        id: z.uuid(),
        count: z.number().int().positive(),
        kinds: z.array(z.enum(contentKinds)),
      }),
    )
    .max(100),
  rules: z
    .array(
      z.object({
        id: z.uuid(),
        config: ruleSchema,
        enabled: z.boolean().optional(),
        consumedCount: z.number().int().nonnegative().optional(),
      }),
    )
    .max(20),
  targets: z.array(z.object({ id: z.uuid(), title: z.string() })).max(20),
  pending: z
    .array(
      z.object({
        messageId: z.number().int().positive(),
        groupKey: z.string().nullable(),
        receivedAt: z.string(),
        payload: z.unknown(),
        failed: z.boolean(),
      }),
    )
    .max(100),
});
export type Draft = z.infer<typeof draftSchema>;
export const steps = [
  'NAME',
  'CONTENT',
  'RULE_TYPE',
  'RULE_FIELDS',
  'RULE_REVIEW',
  'RULE_LIST',
  'TARGETS',
  'PREVIEW',
  'TIMEZONE',
  'POLICY',
] as const;
export const workSchema = z.object({
  builder: z
    .object({
      type: z.enum([
        'ONE_TIME',
        'EVERY_N_DAYS',
        'WEEKLY',
        'MONTHLY',
        'YEARLY',
        'INTERVAL',
      ]),
      values: z.record(z.string(), z.string()),
      weekdays: z.array(z.number().int().min(1).max(7)),
      index: z.number().int().nonnegative(),
    })
    .nullable(),
  targetOptions: z.array(z.object({ id: z.uuid(), title: z.string() })),
  page: z.number().int().nonnegative(),
  hasNext: z.boolean(),
  nameReturn: z.boolean(),
  editingRule: z.number().int().nonnegative().nullable().optional(),
  replacingContent: z.number().int().nonnegative().nullable().optional(),
  contentPage: z.number().int().nonnegative().optional(),
});
export type Builder = NonNullable<z.infer<typeof workSchema>['builder']>;
export interface Session {
  id: string;
  token: string;
  ownerId: string;
  revision: number;
  step: (typeof steps)[number];
  status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED' | 'COMMITTED';
  expiresAt: string;
  draft: Draft;
  work: z.infer<typeof workSchema>;
  editing?: { reminderId: string; versionId: string };
}
export interface View {
  text: string;
  buttons: { text: string; data: string }[][];
}
export interface WizardUnitOfWork {
  current(now: string): Promise<Session | null>;
  create(now: string): Promise<Session>;
  edit?(reminderId: string, now: string): Promise<Session>;
  save(session: Session): Promise<void>;
  commit(session: Session, now: string): Promise<string>;
}
export interface WizardRepository {
  run(
    ownerId: string,
    updateId: number,
    operation: (work: WizardUnitOfWork) => Promise<View | null>,
  ): Promise<View | null>;
}
export type WizardInput =
  | { type: 'start' | 'cancel' }
  | { type: 'edit'; reminderId: string }
  | { type: 'text'; text: string }
  | {
      type: 'content';
      messageId: number;
      groupKey: string | null;
      payload: unknown;
    }
  | {
      type: 'message';
      text: string | null;
      messageId: number;
      groupKey: string | null;
      payload: unknown;
    }
  | { type: 'callback'; data: string };
export const emptyWork = (): Session['work'] => ({
  builder: null,
  targetOptions: [],
  page: 0,
  hasNext: false,
  nameReturn: false,
});
