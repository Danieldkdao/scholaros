import { eq } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AuthorizedRegistrar } from '@scholaros/services/learning/product-contracts';
import type { NotificationOutcome } from '../services/notification-actions';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-notifications-'));
  const app = {
    getPath: () => userData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    once: vi.fn(),
    on: vi.fn(),
  };
  return { app, default: { app } };
});

const { db } = await import('../../../db');
const {
  AcademicConnectionTable,
  ContextItemTable,
  CourseTable,
  NotificationEventTable,
  SettingTable,
  StudySessionTable,
} = await import('../../../db/schema');
const {
  cancelNotificationsForTarget,
  clearNotificationPermissionState,
  enqueueProductNotification,
  getNotificationSettings,
  getNotificationPermissionState,
  registerNotificationActions,
  saveNotificationSettings,
  setNotificationFocusState,
  setNotificationPermissionState,
} = await import('../services/notification-actions');
const { claimNotificationEventsForUser, settleNotificationEventForUser } =
  await import('../services/notification-store');
const { createDefaultNotificationSettings } =
  await import('../services/notification-policy');

const accountA = 'notification-account-a';
const accountB = 'notification-account-b';
const authorizedContext = (userId: string) => ({
  userId,
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
});
const first = '2026-11-03T12:00:00.000Z';

const insertCourse = (userId: string, id: string) =>
  db
    .insert(CourseTable)
    .values({
      id,
      userId,
      connectionId: null,
      sourceKey: `manual:${id}`,
      sourceName: 'Manual',
      sourceHost: '',
      name: 'Biology',
      url: '',
      firstSeenAt: first,
      lastSeenAt: first,
    })
    .run();

const enabledSettings = () => {
  const settings = createDefaultNotificationSettings();
  return {
    enabled: true,
    categories: { ...settings.categories, 'sync-completed': true },
    quietHours: settings.quietHours,
  };
};

const outcome = (
  overrides: Partial<NotificationOutcome> = {},
): NotificationOutcome => ({
  category: 'sync-completed',
  outcome: 'completed',
  outcomeId: 'sync-operation-1:complete',
  targetKind: 'course',
  targetId: 'course-a',
  route: { kind: 'course', courseId: 'course-a' },
  expiresAt: '2030-01-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  db.delete(NotificationEventTable).run();
  db.delete(StudySessionTable).run();
  db.delete(ContextItemTable).run();
  db.delete(CourseTable).run();
  db.delete(AcademicConnectionTable).run();
  db.delete(SettingTable).run();
  clearNotificationPermissionState(authorizedContext(accountA));
  clearNotificationPermissionState(authorizedContext(accountB));
  insertCourse(accountA, 'course-a');
  insertCourse(accountB, 'course-b');
});

it('returns off-by-default notification settings for accounts without a row', async () => {
  const settings = await getNotificationSettings(authorizedContext(accountA));

  expect(settings.enabled).toBe(false);
  expect(Object.values(settings.categories).every((enabled) => !enabled)).toBe(
    true,
  );
  expect(settings.revision).toBe(0);
});

it('rejects enabling notifications without a trusted permission result', async () => {
  await expect(
    saveNotificationSettings(authorizedContext(accountA), {
      settings: enabledSettings(),
      expectedRevision: 0,
    }),
  ).rejects.toMatchObject({ code: 'permission-revoked' });
  expect(
    (await getNotificationSettings(authorizedContext(accountA))).enabled,
  ).toBe(false);
});

it('increments only the notification revision and preserves unrelated preferences', async () => {
  const defaults = createDefaultNotificationSettings();
  db.insert(SettingTable)
    .values({
      userId: accountA,
      updatedAt: first,
      productPreferences: {
        grades: { enabled: true, notes: 'keep grade notes', revision: 4 },
        notifications: defaults,
        learning: {
          educationLevel: 'college',
          appearance: 'dark',
          accessibility: { reduceMotion: true, highContrast: false },
          revision: 7,
        },
      },
    })
    .run();
  const context = authorizedContext(accountA);
  setNotificationPermissionState(context, 'granted');
  const saved = await saveNotificationSettings(context, {
    settings: enabledSettings(),
    expectedRevision: 0,
  });
  const row = db
    .select({ productPreferences: SettingTable.productPreferences })
    .from(SettingTable)
    .where(eq(SettingTable.userId, accountA))
    .get();

  expect(saved).toMatchObject({ enabled: true, revision: 1 });
  expect(row?.productPreferences.grades).toEqual({
    enabled: true,
    notes: 'keep grade notes',
    revision: 4,
  });
  expect(row?.productPreferences.learning).toEqual({
    educationLevel: 'college',
    appearance: 'dark',
    accessibility: { reduceMotion: true, highContrast: false },
    revision: 7,
  });
});

it('rejects a stale settings revision without overwriting the latest preferences', async () => {
  const context = authorizedContext(accountA);
  setNotificationPermissionState(context, 'granted');
  await saveNotificationSettings(context, {
    settings: enabledSettings(),
    expectedRevision: 0,
  });

  await expect(
    saveNotificationSettings(context, {
      settings: { ...enabledSettings(), enabled: false },
      expectedRevision: 0,
    }),
  ).rejects.toMatchObject({ code: 'revision-conflict' });
  expect((await getNotificationSettings(context)).enabled).toBe(true);
});

it('publishes the committed preference revision for Settings observers', async () => {
  const context = authorizedContext(accountA);
  const handlers = new Map<
    string,
    (context: unknown, input: unknown) => Promise<unknown>
  >();
  const publish = vi.fn();
  const registrar = {
    handle: (name: string, handler: unknown) => {
      handlers.set(
        name,
        handler as (context: unknown, input: unknown) => Promise<unknown>,
      );
    },
    publish,
  };
  setNotificationPermissionState(context, 'granted');
  const unregister = registerNotificationActions(
    registrar as unknown as AuthorizedRegistrar,
  );
  const save = handlers.get('saveNotificationSettings');
  expect(save).toBeDefined();
  const result = await save!(context, {
    settings: enabledSettings(),
    expectedRevision: 0,
  });

  expect(result).toMatchObject({ enabled: true, revision: 1 });
  expect(publish).toHaveBeenCalledWith({
    version: 1,
    accountId: accountA,
    revision: 1,
    resource: 'notifications',
    targetId: null,
  });
  await unregister();
});

it('claims and settles notifications only through its internal service action', async () => {
  const context = authorizedContext(accountA);
  setNotificationPermissionState(context, 'granted');
  await saveNotificationSettings(context, {
    settings: enabledSettings(),
    expectedRevision: 0,
  });
  await enqueueProductNotification(context, outcome());
  const handlers = new Map<
    string,
    (context: unknown, input: unknown) => Promise<unknown>
  >();
  const registrar = {
    handle: (name: string, handler: unknown) => {
      handlers.set(
        name,
        handler as (context: unknown, input: unknown) => Promise<unknown>,
      );
    },
    publish: vi.fn(),
  };
  const unregister = registerNotificationActions(
    registrar as unknown as AuthorizedRegistrar,
  );
  const deliveryAction = handlers.get('claimDueNotifications');
  expect(deliveryAction).toBeDefined();
  const now = '2026-11-03T12:00:00.000Z';
  const claimed = (await deliveryAction!(context, {
    operation: 'claim',
    userId: accountA,
    now,
    isFocused: false,
  })) as { id: string; claimedAt: string }[];
  expect(claimed).toHaveLength(1);
  expect(
    await deliveryAction!(context, {
      operation: 'authorize-show',
      userId: accountA,
      eventId: claimed[0]!.id,
      claimedAt: claimed[0]!.claimedAt,
      now,
      isFocused: false,
    }),
  ).toBe(true);
  expect(
    await deliveryAction!(context, {
      operation: 'settle',
      userId: accountA,
      eventId: claimed[0]!.id,
      claimedAt: claimed[0]!.claimedAt,
      status: 'delivered',
      now,
    }),
  ).toBe(true);
  expect(db.select().from(NotificationEventTable).all()[0]?.status).toBe(
    'delivered',
  );
  await unregister();
});

it('records disabled outcomes as suppressed and rejects nonterminal work', async () => {
  const context = authorizedContext(accountA);
  const result = await enqueueProductNotification(context, outcome());
  const events = db.select().from(NotificationEventTable).all();

  expect(result.status).toBe('suppressed');
  expect(events).toHaveLength(1);
  expect(events[0]?.status).toBe('suppressed');
  const nonterminalOutcome = {
    ...outcome({ outcomeId: 'sync-operation-2' }),
    outcome: 'queued',
  } as unknown as NotificationOutcome;
  await expect(
    enqueueProductNotification(context, nonterminalOutcome),
  ).rejects.toThrow();
});

it('suppresses an outcome immediately when the trusted app-focus state is active', async () => {
  const context = authorizedContext(accountA);
  setNotificationPermissionState(context, 'granted');
  await saveNotificationSettings(context, {
    settings: enabledSettings(),
    expectedRevision: 0,
  });
  setNotificationFocusState(context, true);

  const result = await enqueueProductNotification(context, outcome());

  expect(result.status).toBe('suppressed');
  expect(db.select().from(NotificationEventTable).all()[0]?.status).toBe(
    'suppressed',
  );
});

it('cancels a queued notification after its course is deactivated', async () => {
  const context = authorizedContext(accountA);
  setNotificationPermissionState(context, 'granted');
  await saveNotificationSettings(context, {
    settings: enabledSettings(),
    expectedRevision: 0,
  });
  await enqueueProductNotification(context, outcome());
  db.update(CourseTable)
    .set({ active: false })
    .where(eq(CourseTable.id, 'course-a'))
    .run();

  const claimedEvents = claimNotificationEventsForUser(accountA, {
    now: new Date(),
    isFocused: false,
    permission: 'granted',
  });

  expect(claimedEvents).toEqual([]);
  expect(db.select().from(NotificationEventTable).all()[0]?.status).toBe(
    'cancelled',
  );
});

it('deduplicates the same persisted outcome within its account and category', async () => {
  const context = authorizedContext(accountA);
  setNotificationPermissionState(context, 'granted');
  await saveNotificationSettings(context, {
    settings: enabledSettings(),
    expectedRevision: 0,
  });

  const firstResult = await enqueueProductNotification(context, outcome());
  const replay = await enqueueProductNotification(context, outcome());

  expect(firstResult).toMatchObject({ status: 'queued', created: true });
  expect(replay).toMatchObject({
    eventId: firstResult.eventId,
    status: 'queued',
    created: false,
  });
  expect(db.select().from(NotificationEventTable).all()).toHaveLength(1);
});

it('claims notifications in FIFO order with a stable tie-break for equal timestamps', async () => {
  const context = authorizedContext(accountA);
  setNotificationPermissionState(context, 'granted');
  await saveNotificationSettings(context, {
    settings: enabledSettings(),
    expectedRevision: 0,
  });
  db.insert(NotificationEventTable)
    .values([
      {
        id: 'event-z',
        userId: accountA,
        category: 'sync-completed',
        targetKind: 'course',
        targetId: 'course-a',
        outcomeId: 'outcome-z',
        preferenceRevision: 1,
        status: 'queued',
        deliverAfter: null,
        expiresAt: '2030-01-01T00:00:00.000Z',
        claimedAt: null,
        deliveredAt: null,
        safeRoute: { kind: 'course', courseId: 'course-a' },
        createdAt: '2026-11-03T12:02:00.000Z',
      },
      {
        id: 'event-c',
        userId: accountA,
        category: 'sync-completed',
        targetKind: 'course',
        targetId: 'course-a',
        outcomeId: 'outcome-c',
        preferenceRevision: 1,
        status: 'queued',
        deliverAfter: null,
        expiresAt: '2030-01-01T00:00:00.000Z',
        claimedAt: null,
        deliveredAt: null,
        safeRoute: { kind: 'course', courseId: 'course-a' },
        createdAt: '2026-11-03T12:01:00.000Z',
      },
      {
        id: 'event-a',
        userId: accountA,
        category: 'sync-completed',
        targetKind: 'course',
        targetId: 'course-a',
        outcomeId: 'outcome-a',
        preferenceRevision: 1,
        status: 'queued',
        deliverAfter: null,
        expiresAt: '2030-01-01T00:00:00.000Z',
        claimedAt: null,
        deliveredAt: null,
        safeRoute: { kind: 'course', courseId: 'course-a' },
        createdAt: '2026-11-03T12:00:00.000Z',
      },
      {
        id: 'event-b',
        userId: accountA,
        category: 'sync-completed',
        targetKind: 'course',
        targetId: 'course-a',
        outcomeId: 'outcome-b',
        preferenceRevision: 1,
        status: 'queued',
        deliverAfter: null,
        expiresAt: '2030-01-01T00:00:00.000Z',
        claimedAt: null,
        deliveredAt: null,
        safeRoute: { kind: 'course', courseId: 'course-a' },
        createdAt: '2026-11-03T12:01:00.000Z',
      },
    ])
    .run();

  const claimed = claimNotificationEventsForUser(accountA, {
    now: new Date('2026-11-03T12:03:00.000Z'),
    isFocused: false,
    permission: 'granted',
  });

  expect(claimed.map((event) => event.id)).toEqual([
    'event-a',
    'event-b',
    'event-c',
    'event-z',
  ]);
});

it('fails an expired claim lease without replaying or accepting its late acknowledgement', async () => {
  const context = authorizedContext(accountA);
  setNotificationPermissionState(context, 'granted');
  await saveNotificationSettings(context, {
    settings: enabledSettings(),
    expectedRevision: 0,
  });
  await enqueueProductNotification(context, outcome());
  const claimTime = new Date('2026-11-03T12:00:00.000Z');
  const claimedNotification = claimNotificationEventsForUser(accountA, {
    now: claimTime,
    isFocused: false,
    permission: 'granted',
  })[0];
  expect(claimedNotification?.claimedAt).toBe(claimTime.toISOString());
  expect(
    claimNotificationEventsForUser(accountA, {
      now: claimTime,
      isFocused: false,
      permission: 'granted',
    }),
  ).toEqual([]);

  const recoveryTime = new Date('2026-11-03T12:10:00.000Z');
  expect(
    claimNotificationEventsForUser(accountA, {
      now: recoveryTime,
      isFocused: false,
      permission: 'granted',
    }),
  ).toEqual([]);
  expect(db.select().from(NotificationEventTable).all()[0]?.status).toBe(
    'failed',
  );
  expect(
    settleNotificationEventForUser(
      accountA,
      claimedNotification!.id,
      claimedNotification!.claimedAt!,
      'delivered',
      recoveryTime,
    ),
  ).toBe(false);
});

it('recomputes a queued quiet-hours delay when quiet hours are changed', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-03T04:00:00.000Z'));
  try {
    const context = authorizedContext(accountA);
    const settings = {
      ...enabledSettings(),
      quietHours: {
        enabled: true,
        startMinute: 22 * 60,
        endMinute: 8 * 60,
        timeZone: 'America/Chicago',
      },
    };
    setNotificationPermissionState(context, 'granted');
    await saveNotificationSettings(context, { settings, expectedRevision: 0 });
    await enqueueProductNotification(context, outcome());
    const queued = db.select().from(NotificationEventTable).all()[0]!;
    expect(queued.deliverAfter).toBe('2026-11-03T14:00:00.000Z');

    await saveNotificationSettings(context, {
      settings: {
        ...settings,
        quietHours: { ...settings.quietHours, enabled: false },
      },
      expectedRevision: 1,
    });

    const rescheduled = db.select().from(NotificationEventTable).all()[0]!;
    expect(rescheduled.status).toBe('queued');
    expect(rescheduled.deliverAfter).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('cancels queued and visible alerts when native permission is denied', async () => {
  const context = authorizedContext(accountA);
  setNotificationPermissionState(context, 'granted');
  await saveNotificationSettings(context, {
    settings: enabledSettings(),
    expectedRevision: 0,
  });
  await enqueueProductNotification(context, outcome());
  const notification = db.select().from(NotificationEventTable).all()[0]!;
  db.update(NotificationEventTable)
    .set({ status: 'delivered', deliveredAt: first })
    .where(eq(NotificationEventTable.id, notification.id))
    .run();

  setNotificationPermissionState(context, 'denied');

  expect(getNotificationPermissionState(context)).toBe('denied');
  expect(db.select().from(NotificationEventTable).all()[0]?.status).toBe(
    'cancelled',
  );
});

it('cancels account alerts and clears permission state on sign-out', async () => {
  const context = authorizedContext(accountA);
  setNotificationPermissionState(context, 'granted');
  await saveNotificationSettings(context, {
    settings: enabledSettings(),
    expectedRevision: 0,
  });
  await enqueueProductNotification(context, outcome());

  clearNotificationPermissionState(context);

  expect(getNotificationPermissionState(context)).toBe('unknown');
  expect(db.select().from(NotificationEventTable).all()[0]?.status).toBe(
    'cancelled',
  );
});

it('cancels queued and visible alerts when the master switch is disabled', async () => {
  const context = authorizedContext(accountA);
  setNotificationPermissionState(context, 'granted');
  await saveNotificationSettings(context, {
    settings: enabledSettings(),
    expectedRevision: 0,
  });
  await enqueueProductNotification(context, outcome());
  const event = db.select().from(NotificationEventTable).all()[0]!;
  db.update(NotificationEventTable)
    .set({ status: 'delivered', deliveredAt: first })
    .where(eq(NotificationEventTable.id, event.id))
    .run();

  await saveNotificationSettings(context, {
    settings: { ...enabledSettings(), enabled: false },
    expectedRevision: 1,
  });

  expect(db.select().from(NotificationEventTable).all()[0]?.status).toBe(
    'cancelled',
  );
});

it('rejects a target owned by another account and cancels only the matching account target', async () => {
  const contextA = authorizedContext(accountA);
  const contextB = authorizedContext(accountB);
  setNotificationPermissionState(contextA, 'granted');
  setNotificationPermissionState(contextB, 'granted');
  await saveNotificationSettings(contextA, {
    settings: enabledSettings(),
    expectedRevision: 0,
  });
  await saveNotificationSettings(contextB, {
    settings: enabledSettings(),
    expectedRevision: 0,
  });

  const otherAccountTarget = await enqueueProductNotification(
    contextA,
    outcome({
      outcomeId: 'foreign-target',
      targetId: 'course-b',
      route: { kind: 'course', courseId: 'course-b' },
    }),
  );
  expect(otherAccountTarget.status).toBe('suppressed');

  await enqueueProductNotification(contextA, outcome());
  await enqueueProductNotification(
    contextB,
    outcome({
      outcomeId: 'account-b-outcome',
      targetId: 'course-b',
      route: { kind: 'course', courseId: 'course-b' },
    }),
  );
  await cancelNotificationsForTarget(contextA, {
    targetKind: 'course',
    targetId: 'course-a',
  });

  const events = db.select().from(NotificationEventTable).all();
  expect(
    events.find(
      (event) => event.userId === accountA && event.targetId === 'course-a',
    )?.status,
  ).toBe('cancelled');
  expect(events.find((event) => event.userId === accountB)?.status).toBe(
    'queued',
  );
});
