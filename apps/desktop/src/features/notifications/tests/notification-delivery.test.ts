import { eq } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(
    join(tmpdir(), 'scholaros-notification-delivery-'),
  );
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
  getNotificationsForAccount,
  saveNotificationSettings,
  setNotificationPermissionState,
} = await import('../services/notification-actions');
const { createDefaultNotificationSettings } =
  await import('../services/notification-policy');
const { createNotificationDelivery } =
  await import('../services/notification-delivery');

const accountId = 'delivery-account';
const first = '2026-11-03T12:00:00.000Z';
const authorizedContext = (isCurrent = () => true) => ({
  userId: accountId,
  epoch: 1,
  isCurrent,
  signal: new AbortController().signal,
});

const insertCourse = () =>
  db
    .insert(CourseTable)
    .values({
      id: 'course-a',
      userId: accountId,
      connectionId: null,
      sourceKey: 'manual:course-a',
      sourceName: 'Manual',
      sourceHost: '',
      name: 'Biology',
      url: '',
      firstSeenAt: first,
      lastSeenAt: first,
    })
    .run();

const insertContextItem = () =>
  db
    .insert(ContextItemTable)
    .values({
      id: 'context-a',
      userId: accountId,
      title: 'Private course notes',
      kind: 'document',
      provenance: 'user-uploaded',
      currentVersionId: null,
      status: 'complete',
      revision: 0,
      removedAt: null,
      originatingSessionId: null,
      originatingSourceId: null,
      createdAt: first,
      updatedAt: first,
    })
    .run();

const setEnabledSettings = async (
  context = authorizedContext(),
  extraCategories: Record<string, boolean> = {},
) => {
  const defaults = createDefaultNotificationSettings();
  const settings = {
    enabled: true,
    categories: {
      ...defaults.categories,
      'sync-completed': true,
      ...extraCategories,
    },
    quietHours: defaults.quietHours,
  };
  setNotificationPermissionState(context, 'granted');
  await saveNotificationSettings(context, { settings, expectedRevision: 0 });
};

const enqueueCourseOutcome = async (context = authorizedContext()) =>
  enqueueProductNotification(context, {
    category: 'sync-completed',
    outcome: 'completed',
    outcomeId: 'sync-operation-1:complete',
    targetKind: 'course',
    targetId: 'course-a',
    route: { kind: 'course', courseId: 'course-a' },
    expiresAt: '2030-01-01T00:00:00.000Z',
  });

const eventsForAccount = () => getNotificationsForAccount(accountId) ?? [];

beforeEach(() => {
  db.delete(NotificationEventTable).run();
  db.delete(StudySessionTable).run();
  db.delete(ContextItemTable).run();
  db.delete(CourseTable).run();
  db.delete(AcademicConnectionTable).run();
  db.delete(SettingTable).run();
  clearNotificationPermissionState(authorizedContext());
  insertCourse();
});

it('persists the claim before showing and delivers one generic alert at most once', async () => {
  const context = authorizedContext();
  await setEnabledSettings(context);
  await enqueueCourseOutcome(context);
  const show = vi.fn(async ({ eventId, title, body }) => {
    const event = db
      .select()
      .from(NotificationEventTable)
      .where(eq(NotificationEventTable.id, eventId))
      .get();
    expect(event?.status).toBe('claimed');
    expect(title).toBe('Sync complete');
    expect(body).toBe('Your academic information is ready to review.');
    expect(body).not.toContain('Biology');
    return 'shown' as const;
  });
  const delivery = createNotificationDelivery({
    isFocused: () => false,
    show,
    route: vi.fn(),
    validateTarget: () => true,
  });

  await delivery.deliverDueNotifications(context);
  await delivery.deliverDueNotifications(context);

  expect(show).toHaveBeenCalledOnce();
  expect(eventsForAccount()[0]?.status).toBe('delivered');
});

it('suppresses OS delivery while the app is focused', async () => {
  const context = authorizedContext();
  await setEnabledSettings(context);
  await enqueueCourseOutcome(context);
  const show = vi.fn(async () => 'shown' as const);
  const delivery = createNotificationDelivery({
    isFocused: () => true,
    show,
    route: vi.fn(),
    validateTarget: () => true,
  });

  await delivery.deliverDueNotifications(context);

  expect(show).not.toHaveBeenCalled();
  expect(eventsForAccount()[0]?.status).toBe('suppressed');
});

it('rechecks account settings after host validation and before native show', async () => {
  const context = authorizedContext();
  await setEnabledSettings(context);
  await enqueueCourseOutcome(context);
  const show = vi.fn(async () => 'shown' as const);
  const delivery = createNotificationDelivery({
    isFocused: () => false,
    show,
    route: vi.fn(),
    validateTarget: async () => {
      const defaults = createDefaultNotificationSettings();
      await saveNotificationSettings(context, {
        settings: {
          enabled: false,
          categories: { ...defaults.categories, 'sync-completed': true },
          quietHours: defaults.quietHours,
        },
        expectedRevision: 1,
      });
      return true;
    },
  });

  await delivery.deliverDueNotifications(context);

  expect(show).not.toHaveBeenCalled();
  expect(eventsForAccount()[0]?.status).toBe('cancelled');
});

it('records native display failure and does not retry the same outcome', async () => {
  const context = authorizedContext();
  await setEnabledSettings(context);
  const enqueued = await enqueueCourseOutcome(context);
  expect(enqueued.status).toBe('queued');
  const show = vi.fn(async () => 'failed' as const);
  const delivery = createNotificationDelivery({
    isFocused: () => false,
    show,
    route: vi.fn(),
    validateTarget: () => true,
  });

  await delivery.deliverDueNotifications(context);
  await delivery.deliverDueNotifications(context);

  expect(show).toHaveBeenCalledOnce();
  expect(eventsForAccount()[0]?.status).toBe('failed');
});

it('re-evaluates quiet hours after a wall-clock change', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-03T04:00:00.000Z'));
  try {
    const context = authorizedContext();
    const defaults = createDefaultNotificationSettings();
    const settings = {
      enabled: true,
      categories: { ...defaults.categories, 'sync-completed': true },
      quietHours: {
        enabled: true,
        startMinute: 22 * 60,
        endMinute: 8 * 60,
        timeZone: 'America/Chicago',
      },
    };
    setNotificationPermissionState(context, 'granted');
    await saveNotificationSettings(context, { settings, expectedRevision: 0 });
    await enqueueCourseOutcome(context);
    expect(eventsForAccount()[0]?.deliverAfter).toBe(
      '2026-11-03T14:00:00.000Z',
    );

    vi.setSystemTime(new Date('2026-11-03T02:00:00.000Z'));
    const show = vi.fn(async () => 'shown' as const);
    const delivery = createNotificationDelivery({
      isFocused: () => false,
      show,
      route: vi.fn(),
      validateTarget: () => true,
    });
    await delivery.deliverDueNotifications(context);

    expect(show).toHaveBeenCalledOnce();
    expect(eventsForAccount()[0]?.status).toBe('delivered');
  } finally {
    vi.useRealTimers();
  }
});

it('does not route a click after its target is removed', async () => {
  const context = authorizedContext();
  await setEnabledSettings(context, { 'context-completed': true });
  insertContextItem();
  await enqueueProductNotification(context, {
    category: 'context-completed',
    outcome: 'completed',
    outcomeId: 'context-operation-1:complete',
    targetKind: 'context',
    targetId: 'context-a',
    route: { kind: 'context', itemId: 'context-a' },
    expiresAt: '2030-01-01T00:00:00.000Z',
  });
  let click: (() => Promise<boolean>) | undefined;
  const route = vi.fn();
  const delivery = createNotificationDelivery({
    isFocused: () => false,
    show: async (notification) => {
      click = notification.onClick;
      return 'shown';
    },
    route,
    validateTarget: () => true,
  });
  await delivery.deliverDueNotifications(context);
  db.delete(ContextItemTable).run();

  expect(await click?.()).toBe(false);
  expect(route).not.toHaveBeenCalled();
});

it('dismisses an alert cancelled while native display is in flight', async () => {
  const context = authorizedContext();
  await setEnabledSettings(context);
  await enqueueCourseOutcome(context);
  const dismiss = vi.fn();
  const delivery = createNotificationDelivery({
    isFocused: () => false,
    show: async () => {
      await cancelNotificationsForTarget(context);
      return 'shown';
    },
    dismiss,
    route: vi.fn(),
    validateTarget: () => true,
  });

  await delivery.deliverDueNotifications(context);

  expect(eventsForAccount()[0]?.status).toBe('cancelled');
  expect(dismiss).toHaveBeenCalledWith(eventsForAccount()[0]?.id);
});

it('cancels a claimed alert when the account becomes stale before display', async () => {
  let current = true;
  const context = authorizedContext(() => current);
  await setEnabledSettings(context);
  await enqueueCourseOutcome(context);
  const show = vi.fn(async () => 'shown' as const);
  const delivery = createNotificationDelivery({
    isFocused: () => false,
    show,
    route: vi.fn(),
    validateTarget: () => {
      current = false;
      return true;
    },
  });

  await delivery.deliverDueNotifications(context);

  expect(show).not.toHaveBeenCalled();
  expect(eventsForAccount()[0]?.status).toBe('cancelled');
});

it('does not route an OS click after its originating account becomes stale', async () => {
  let current = true;
  const context = authorizedContext(() => current);
  await setEnabledSettings(context);
  await enqueueCourseOutcome(context);
  let click: (() => Promise<boolean>) | undefined;
  const route = vi.fn();
  const delivery = createNotificationDelivery({
    isFocused: () => false,
    show: async (notification) => {
      click = notification.onClick;
      return 'shown';
    },
    route,
    validateTarget: () => true,
  });

  await delivery.deliverDueNotifications(context);
  current = false;

  await expect(click?.()).resolves.toBe(false);
  expect(route).not.toHaveBeenCalled();
});
