import { afterEach, expect, it, vi } from 'vitest';
import type { NotificationEventSelectData } from '../../../db/schema';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import type { SafeRoute } from '@scholaros/services/learning/notification-contracts';

const service = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../client', () => ({ requestAcademicService: service.request }));

const { createNotificationHostAdapter } =
  await import('../notification-host-adapter');

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
const context: AuthorizedContext = {
  userId: accountId,
  epoch: 1,
  signal: new AbortController().signal,
  isCurrent: () => true,
};
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

afterEach(() => {
  service.request.mockReset();
});

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
    if (command.operation === 'get-click')
      return { ...event, status: 'delivered', deliveredAt: event.createdAt };
    if (command.operation === 'authorize-click') return event.safeRoute;
    return true;
  });
  const adapter = createNotificationHostAdapter(
    dependencies({ route, validateTarget }) as never,
  );

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
  service.request.mockResolvedValue({
    ...event,
    status: 'delivered',
    safeRoute: { kind: 'external', url: 'https://example.com' },
  });
  const route = vi.fn();
  const validateTarget = vi.fn();
  const adapter = createNotificationHostAdapter(
    dependencies({ route, validateTarget }) as never,
  );

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
