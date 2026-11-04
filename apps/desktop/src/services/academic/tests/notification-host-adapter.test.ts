import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NotificationEventSelectData } from '../../../db/schema';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import type { AuthorizedRegistrar } from '@scholaros/services/learning/product-contracts';
import type { SafeRoute } from '@scholaros/services/learning/notification-contracts';
import type { NativeNotificationDisplay } from '../../../features/notifications/services/notification-delivery';

const service = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../client', () => ({ requestAcademicService: service.request }));
vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-notification-host-'));
  const app = {
    getPath: () => userData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    once: vi.fn(),
    on: vi.fn(),
  };
  return { app, default: { app } };
});

const { createNotificationHostAdapter } =
  await import('../notification-host-adapter');
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
  enqueueProductNotification,
  registerNotificationActions,
  saveNotificationSettings,
  setNotificationPermissionState,
} =
  await import('../../../features/notifications/services/notification-actions');
const { createDefaultNotificationSettings } =
  await import('../../../features/notifications/services/notification-policy');
const { getNotificationEventForUser, isNotificationTargetAvailable } =
  await import('../../../features/notifications/services/notification-store');

const accountId = 'notification-host-account';
const event: NotificationEventSelectData = {
  id: 'notification-event-a',
  userId: accountId,
  category: 'sync-completed',
  targetKind: 'course',
  targetId: 'course-a',
  outcomeId: 'sync-a:complete',
  preferenceRevision: 2,
  status: 'claimed',
  deliverAfter: null,
  expiresAt: '2030-01-01T00:00:00.000Z',
  claimedAt: '2026-11-03T12:00:00.000Z',
  deliveredAt: null,
  safeRoute: { kind: 'course', courseId: 'course-a' },
  createdAt: '2026-11-03T11:59:00.000Z',
};
const first = '2026-11-03T12:00:00.000Z';
const context: AuthorizedContext = {
  userId: accountId,
  epoch: 1,
  signal: new AbortController().signal,
  isCurrent: () => true,
};
let unregisterRealActions: () => Promise<void> = async () => undefined;
const dependencies = (overrides: Record<string, unknown> = {}) => ({
  isFocused: () => false,
  show: vi.fn(async () => 'shown' as const),
  dismiss: vi.fn(),
  permission: vi.fn(async () => 'granted' as const),
  route: vi.fn(),
  validateTarget: vi.fn(async () => true),
  now: () => new Date('2026-11-03T12:00:01.000Z'),
  ...overrides,
});

const mockServiceReplies = () => {
  service.request.mockImplementation(async (_method, input) => {
    const command = input as { operation: string };
    switch (command.operation) {
      case 'claim':
        return [{ ...event, status: 'claimed' }];
      case 'get-click':
        return { ...event, status: 'delivered', deliveredAt: event.createdAt };
      case 'authorize-show':
      case 'settle':
      case 'set-focus':
      case 'set-permission':
      case 'clear-account':
        return true;
      case 'authorize-click':
        return event.safeRoute;
      default:
        throw new Error(
          `Unexpected notification command: ${command.operation}`,
        );
    }
  });
};

beforeEach(() => {
  db.delete(NotificationEventTable).run();
  db.delete(StudySessionTable).run();
  db.delete(ContextItemTable).run();
  db.delete(CourseTable).run();
  db.delete(AcademicConnectionTable).run();
  db.delete(SettingTable).run();
});

afterEach(async () => {
  await unregisterRealActions();
  unregisterRealActions = async () => undefined;
  service.request.mockReset();
});

const insertCourse = (userId: string) =>
  db
    .insert(CourseTable)
    .values({
      id: 'course-a',
      userId,
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

const registerRealService = (contexts: readonly AuthorizedContext[]) => {
  const handlers = new Map<
    string,
    (context: AuthorizedContext, input: unknown) => Promise<unknown>
  >();
  unregisterRealActions = registerNotificationActions({
    handle: (name: string, handler: unknown) => {
      handlers.set(
        name,
        handler as (
          context: AuthorizedContext,
          input: unknown,
        ) => Promise<unknown>,
      );
    },
    publish: vi.fn(),
  } as unknown as AuthorizedRegistrar);
  service.request.mockImplementation(async (_method, input) => {
    const command = input as { userId: string };
    const requestContext = contexts.find(
      (candidate) => candidate.userId === command.userId,
    );
    const handler = handlers.get('claimDueNotifications');
    if (!requestContext || !handler)
      throw new Error('The notification service context is unavailable.');
    return handler(requestContext, input);
  });
};

const prepareRealNotification = async (requestContext: AuthorizedContext) => {
  insertCourse(requestContext.userId);
  setNotificationPermissionState(requestContext, 'granted');
  const defaults = createDefaultNotificationSettings();
  await saveNotificationSettings(requestContext, {
    settings: {
      enabled: true,
      categories: { ...defaults.categories, 'sync-completed': true },
      quietHours: defaults.quietHours,
    },
    expectedRevision: 0,
  });
  return enqueueProductNotification(requestContext, {
    category: 'sync-completed',
    outcome: 'completed',
    outcomeId: `sync-${requestContext.userId}:complete`,
    targetKind: 'course',
    targetId: 'course-a',
    route: { kind: 'course', courseId: 'course-a' },
    expiresAt: '2030-01-01T00:00:00.000Z',
  });
};

it('serializes concurrent adapter instances and waits for service acknowledgement', async () => {
  mockServiceReplies();
  let finishShow!: (result: 'shown') => void;
  const show = vi.fn(
    () =>
      new Promise<'shown'>((resolve) => {
        finishShow = resolve;
      }),
  );
  const firstDependencies = dependencies({ show });
  const secondDependencies = dependencies();
  const firstAdapter = createNotificationHostAdapter(
    firstDependencies as never,
  );
  const secondAdapter = createNotificationHostAdapter(
    secondDependencies as never,
  );

  expect(Object.keys(firstAdapter).sort()).toEqual(
    [
      'clearAccount',
      'deliverDueNotifications',
      'dispose',
      'handleClick',
      'setFocus',
      'setPermission',
    ].sort(),
  );
  const firstRun = firstAdapter.deliverDueNotifications(context);
  const secondRun = secondAdapter.deliverDueNotifications(context);
  await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());

  expect(secondDependencies.show).not.toHaveBeenCalled();
  expect(
    service.request.mock.calls.filter(
      ([, input]) => (input as { operation: string }).operation === 'claim',
    ),
  ).toHaveLength(1);
  finishShow('shown');
  await Promise.all([firstRun, secondRun]);

  expect(service.request).toHaveBeenCalledWith(
    'claimDueNotifications',
    expect.objectContaining({
      operation: 'settle',
      userId: accountId,
      eventId: event.id,
      claimedAt: event.claimedAt,
      status: 'delivered',
    }),
  );
  await Promise.all([firstAdapter.dispose(), secondAdapter.dispose()]);
});

it('continues delivery for a new account after the prior account run settles', async () => {
  let firstAccountCurrent = true;
  const firstContext: AuthorizedContext = {
    ...context,
    isCurrent: () => firstAccountCurrent,
  };
  const secondContext: AuthorizedContext = {
    ...context,
    userId: 'notification-host-account-b',
    isCurrent: () => true,
  };
  const secondEvent: NotificationEventSelectData = {
    ...event,
    id: 'notification-event-b',
    userId: secondContext.userId,
    targetId: 'course-b',
    outcomeId: 'sync-b:complete',
    safeRoute: { kind: 'course', courseId: 'course-b' },
  };
  let finishFirstShow!: (result: 'shown') => void;
  const show = vi.fn(({ eventId }: NativeNotificationDisplay) => {
    if (eventId === event.id)
      return new Promise<'shown'>((resolve) => {
        finishFirstShow = resolve;
      });
    return Promise.resolve('shown' as const);
  });
  service.request.mockImplementation(async (_method, input) => {
    const command = input as { operation: string; userId: string };
    if (command.operation === 'claim')
      return [
        command.userId === firstContext.userId
          ? { ...event, status: 'claimed' }
          : { ...secondEvent, status: 'claimed' },
      ];
    if (command.operation === 'get-click') return null;
    if (command.operation === 'authorize-click') return null;
    return true;
  });
  const adapter = createNotificationHostAdapter(
    dependencies({ show }) as never,
  );

  const firstRun = adapter.deliverDueNotifications(firstContext);
  await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
  firstAccountCurrent = false;
  const secondRun = adapter.deliverDueNotifications(secondContext);
  finishFirstShow('shown');
  await Promise.all([firstRun, secondRun]);

  expect(show).toHaveBeenCalledTimes(2);
  expect(show.mock.calls.map(([notification]) => notification.eventId)).toEqual(
    [event.id, secondEvent.id],
  );
  await adapter.dispose();
});

it('rejects click handling until it has a current delivery context', async () => {
  mockServiceReplies();
  const route = vi.fn();
  const adapter = createNotificationHostAdapter(
    dependencies({ route }) as never,
  );

  await expect(adapter.handleClick(accountId, event.id)).resolves.toBe(false);

  expect(service.request).not.toHaveBeenCalled();
  expect(route).not.toHaveBeenCalled();
  await adapter.dispose();
});

it('validates the persisted typed route and host target before routing a click', async () => {
  mockServiceReplies();
  const callOrder: string[] = [];
  const route = vi.fn(async () => {
    callOrder.push('route');
  });
  const validateTarget = vi.fn(async () => {
    callOrder.push('validate');
    return true;
  });
  service.request.mockImplementation(async (_method, input) => {
    const command = input as { operation: string };
    callOrder.push(command.operation);
    if (command.operation === 'claim') return [{ ...event, status: 'claimed' }];
    if (command.operation === 'get-click')
      return { ...event, status: 'delivered', deliveredAt: event.createdAt };
    if (command.operation === 'authorize-click') return event.safeRoute;
    return true;
  });
  const adapter = createNotificationHostAdapter(
    dependencies({ route, validateTarget }) as never,
  );

  await adapter.deliverDueNotifications(context);
  callOrder.length = 0;
  route.mockClear();
  validateTarget.mockClear();
  await expect(adapter.handleClick(accountId, event.id)).resolves.toBe(true);

  expect(route).toHaveBeenCalledWith({
    kind: 'course',
    courseId: 'course-a',
  } satisfies SafeRoute);
  expect(callOrder).toEqual([
    'get-click',
    'validate',
    'authorize-click',
    'validate',
    'route',
  ]);
  await adapter.dispose();
});

it('does not route when the persisted route fails the SafeRoute contract', async () => {
  mockServiceReplies();
  const route = vi.fn();
  const validateTarget = vi.fn();
  const adapter = createNotificationHostAdapter(
    dependencies({ route, validateTarget }) as never,
  );
  await adapter.deliverDueNotifications(context);
  validateTarget.mockClear();
  service.request.mockResolvedValue({
    ...event,
    status: 'delivered',
    safeRoute: { kind: 'external', url: 'https://example.com' },
  });

  await expect(adapter.handleClick(accountId, event.id)).resolves.toBe(false);
  expect(validateTarget).not.toHaveBeenCalled();
  expect(route).not.toHaveBeenCalled();
  await adapter.dispose();
});

it('cancels the account service state and dismisses its visible notification', async () => {
  mockServiceReplies();
  const native = dependencies();
  const adapter = createNotificationHostAdapter(native as never);
  await adapter.deliverDueNotifications(context);
  await adapter.clearAccount(context);

  expect(service.request).toHaveBeenCalledWith(
    'claimDueNotifications',
    expect.objectContaining({
      operation: 'clear-account',
      userId: accountId,
    }),
  );
  expect(native.dismiss).toHaveBeenCalledWith(event.id);
  await adapter.dispose();
});

it('rejects native click callbacks after adapter teardown', async () => {
  mockServiceReplies();
  let onClick: (() => Promise<boolean>) | undefined;
  const route = vi.fn();
  const native = dependencies({
    show: async (notification: { onClick: () => Promise<boolean> }) => {
      onClick = notification.onClick;
      return 'shown' as const;
    },
    route,
  });
  const adapter = createNotificationHostAdapter(native as never);

  await adapter.deliverDueNotifications(context);
  await adapter.dispose();
  const callsBeforeClick = service.request.mock.calls.length;

  await expect(onClick?.()).resolves.toBe(false);
  expect(service.request).toHaveBeenCalledTimes(callsBeforeClick);
  expect(route).not.toHaveBeenCalled();
});

it('awaits an in-flight native display before disposal resolves', async () => {
  mockServiceReplies();
  let finishShow!: (result: 'shown') => void;
  const show = vi.fn(
    () =>
      new Promise<'shown'>((resolve) => {
        finishShow = resolve;
      }),
  );
  const dismiss = vi.fn();
  const adapter = createNotificationHostAdapter(
    dependencies({ show, dismiss }) as never,
  );
  const delivery = adapter.deliverDueNotifications(context);
  await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
  let stopped = false;
  const stopping = adapter.dispose().then(() => {
    stopped = true;
  });
  await Promise.resolve();

  expect(stopped).toBe(false);
  finishShow('shown');
  await Promise.all([delivery, stopping]);

  expect(stopped).toBe(true);
  expect(service.request).toHaveBeenCalledWith(
    'claimDueNotifications',
    expect.objectContaining({
      operation: 'settle',
      eventId: event.id,
      status: 'cancelled',
    }),
  );
  expect(dismiss).toHaveBeenCalledWith(event.id);
});

it('returns a permission update promise that settles after the service acknowledges it', async () => {
  let acknowledge!: () => void;
  service.request.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        acknowledge = () => resolve(true);
      }),
  );
  const adapter = createNotificationHostAdapter(dependencies() as never);
  const update = adapter.setPermission(context, 'granted');

  try {
    expect(update).toBeInstanceOf(Promise);
    let settled = false;
    const updateResult = Promise.resolve(update).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    acknowledge();
    await updateResult;
    expect(settled).toBe(true);
  } finally {
    acknowledge?.();
    await adapter.dispose();
  }
});

it('does not redeliver persisted events after the host adapter is recreated', async () => {
  registerRealService([context]);
  const notification = await prepareRealNotification(context);
  const show = vi.fn(async () => 'shown' as const);
  const firstAdapter = createNotificationHostAdapter(
    dependencies({
      show,
      validateTarget: isNotificationTargetAvailable,
    }) as never,
  );

  await firstAdapter.deliverDueNotifications(context);
  await firstAdapter.dispose();
  await unregisterRealActions();
  registerRealService([context]);

  const restartedAdapter = createNotificationHostAdapter(
    dependencies({
      show,
      validateTarget: isNotificationTargetAvailable,
    }) as never,
  );
  await restartedAdapter.deliverDueNotifications(context);

  expect(show).toHaveBeenCalledOnce();
  expect(
    getNotificationEventForUser(context.userId, notification.eventId)?.status,
  ).toBe('delivered');
  await restartedAdapter.dispose();
});

it('fails an expired service lease without replaying its native notification', async () => {
  registerRealService([context]);
  const notification = await prepareRealNotification(context);
  const claimTime = new Date();
  const claims = await service.request('claimDueNotifications', {
    operation: 'claim',
    userId: context.userId,
    now: claimTime.toISOString(),
    isFocused: false,
  });
  expect(claims).toHaveLength(1);

  const show = vi.fn(async () => 'shown' as const);
  const adapter = createNotificationHostAdapter(
    dependencies({
      show,
      validateTarget: isNotificationTargetAvailable,
      now: () => new Date(claimTime.getTime() + 6 * 60_000),
    }) as never,
  );
  await adapter.deliverDueNotifications(context);

  expect(show).not.toHaveBeenCalled();
  expect(
    getNotificationEventForUser(context.userId, notification.eventId)?.status,
  ).toBe('failed');
  await adapter.dispose();
});

it('rejects a native click after its persisted target is deactivated', async () => {
  registerRealService([context]);
  await prepareRealNotification(context);
  let onClick: (() => Promise<boolean>) | undefined;
  const route = vi.fn();
  const adapter = createNotificationHostAdapter(
    dependencies({
      show: async (notification: { onClick: () => Promise<boolean> }) => {
        onClick = notification.onClick;
        return 'shown' as const;
      },
      route,
      validateTarget: isNotificationTargetAvailable,
    }) as never,
  );
  await adapter.deliverDueNotifications(context);
  db.update(CourseTable)
    .set({ active: false })
    .where(eq(CourseTable.id, 'course-a'))
    .run();

  await expect(onClick?.()).resolves.toBe(false);

  expect(route).not.toHaveBeenCalled();
  await adapter.dispose();
});

it('rejects foreign-account and stale-session clicks before service access', async () => {
  let current = true;
  const currentContext: AuthorizedContext = {
    ...context,
    isCurrent: () => current,
  };
  registerRealService([currentContext]);
  await prepareRealNotification(currentContext);
  const route = vi.fn();
  const adapter = createNotificationHostAdapter(
    dependencies({
      route,
      validateTarget: isNotificationTargetAvailable,
    }) as never,
  );
  await adapter.deliverDueNotifications(currentContext);
  const callsBeforeClick = service.request.mock.calls.length;

  await expect(
    adapter.handleClick('another-notification-account', event.id),
  ).resolves.toBe(false);
  current = false;
  await expect(adapter.handleClick(context.userId, event.id)).resolves.toBe(
    false,
  );

  expect(service.request).toHaveBeenCalledTimes(callsBeforeClick);
  expect(route).not.toHaveBeenCalled();
  await adapter.dispose();
});

it('rejects direct click handling after disposal even before a delivery run', async () => {
  mockServiceReplies();
  const route = vi.fn();
  const adapter = createNotificationHostAdapter(
    dependencies({ route }) as never,
  );
  await adapter.dispose();
  const callsBeforeClick = service.request.mock.calls.length;

  await expect(adapter.handleClick(accountId, event.id)).resolves.toBe(false);
  expect(service.request).toHaveBeenCalledTimes(callsBeforeClick);
  expect(route).not.toHaveBeenCalled();
});
