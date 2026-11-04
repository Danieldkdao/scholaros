import { z } from 'zod';
import {
  idSchema,
  instantSchema,
} from '@scholaros/services/learning/product-contracts';
import {
  notificationCategories,
  notificationStatuses,
  notificationTargetKinds,
  safeRouteSchema,
} from '@scholaros/services/learning/notification-contracts';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import type { NotificationEventSelectData } from '../../db/schema';
import type { NotificationDeliveryCommand } from '../../features/notifications/services/notification-actions';
import {
  createNotificationDelivery,
  type NotificationDeliveryDependencies,
  type NotificationDeliveryPersistence,
} from '../../features/notifications/services/notification-delivery';
import { notificationPermissionStates } from '../../features/notifications/services/notification-policy';
import type { NotificationPermission } from '../../features/notifications/services/notification-policy';
import { requestAcademicService } from './client';

export type NotificationHostAdapterDependencies =
  NotificationDeliveryDependencies;
export type NotificationHostAdapter = {
  deliverDueNotifications: (context: AuthorizedContext) => Promise<void>;
  handleClick: (userId: string, eventId: string) => Promise<boolean>;
  setFocus: (context: AuthorizedContext, isFocused: boolean) => Promise<void>;
  setPermission: (
    context: AuthorizedContext,
    state: NotificationPermission,
  ) => Promise<void>;
  /** Cancels account events and dismisses visible native alerts; await on sign-out. */
  clearAccount: (context: AuthorizedContext) => Promise<void>;
  /** Stops new work and invalidates clicks; does not clear persisted account events. */
  dispose: () => Promise<void>;
};

type WithoutUserId<Command> = Command extends { userId: string }
  ? Omit<Command, 'userId'>
  : never;
type NotificationServiceCommand = WithoutUserId<NotificationDeliveryCommand>;
const notificationEventSchema: z.ZodType<NotificationEventSelectData> =
  z.strictObject({
    id: idSchema,
    userId: idSchema,
    category: z.enum(notificationCategories),
    targetKind: z.enum(notificationTargetKinds),
    targetId: idSchema.nullable(),
    outcomeId: idSchema,
    preferenceRevision: z.number().int().nonnegative().safe(),
    status: z.enum(notificationStatuses),
    deliverAfter: instantSchema.nullable(),
    expiresAt: instantSchema,
    claimedAt: instantSchema.nullable(),
    deliveredAt: instantSchema.nullable(),
    safeRoute: safeRouteSchema,
    createdAt: instantSchema,
  });
const notificationEventsSchema: z.ZodType<NotificationEventSelectData[]> =
  z.array(notificationEventSchema);
const notificationPermissionSchema = z.enum(notificationPermissionStates);
const booleanResultSchema = z.boolean();
let activeDeliveryRun: Promise<void> | null = null;
let activeDeliveryContext: AuthorizedContext | null = null;

export const createNotificationHostAdapter = (
  dependencies: NotificationHostAdapterDependencies,
): NotificationHostAdapter => {
  let disposed = false;
  let focusedOverride: boolean | null = null;
  let activeContext: AuthorizedContext | null = null;
  const visibleEventsByAccount = new Map<string, Set<string>>();
  const eventOwners = new Map<string, string>();
  const pendingOperations = new Set<Promise<void>>();
  const pendingAccountCleanups = new Set<Promise<void>>();

  const command = async (userId: string, input: NotificationServiceCommand) =>
    requestAcademicService('claimDueNotifications', { ...input, userId });

  const forgetVisibleEvent = (eventId: string) => {
    const userId = eventOwners.get(eventId);
    if (!userId) return;
    eventOwners.delete(eventId);
    const eventIds = visibleEventsByAccount.get(userId);
    eventIds?.delete(eventId);
    if (eventIds?.size === 0) visibleEventsByAccount.delete(userId);
  };

  const dismissAccount = async (userId: string) => {
    const eventIds = [...(visibleEventsByAccount.get(userId) ?? [])];
    await Promise.all(
      eventIds.map(async (eventId) => {
        try {
          await dependencies.dismiss?.(eventId);
        } catch {
          // Native dismissal is best-effort after service cancellation.
        } finally {
          forgetVisibleEvent(eventId);
        }
      }),
    );
  };

  const scheduleOperation = (operation: Promise<void>): Promise<void> => {
    let trackedOperation: Promise<void>;
    trackedOperation = operation.finally(() =>
      pendingOperations.delete(trackedOperation),
    );
    pendingOperations.add(trackedOperation);
    void trackedOperation.catch(() => undefined);
    return trackedOperation;
  };

  const scheduleAccountCleanup = (operation: Promise<void>): Promise<void> => {
    let trackedCleanup: Promise<void>;
    trackedCleanup = operation.finally(() =>
      pendingAccountCleanups.delete(trackedCleanup),
    );
    pendingAccountCleanups.add(trackedCleanup);
    void trackedCleanup.catch(() => undefined);
    return trackedCleanup;
  };

  const persistence: NotificationDeliveryPersistence = {
    claim: async (context, options) => {
      const result = await command(context.userId, {
        operation: 'claim',
        now: options.now.toISOString(),
        isFocused: options.isFocused,
      });
      const events = notificationEventsSchema.parse(result);
      if (
        events.some(
          (event) =>
            event.userId !== context.userId ||
            event.status !== 'claimed' ||
            event.claimedAt === null,
        )
      )
        throw new Error('The notification service returned an invalid claim.');
      for (const event of events) eventOwners.set(event.id, event.userId);
      return events;
    },
    authorizeShow: async (context, eventId, claimedAt, options) => {
      const authorized = booleanResultSchema.parse(
        await command(context.userId, {
          operation: 'authorize-show',
          eventId,
          claimedAt,
          now: options.now.toISOString(),
          isFocused: options.isFocused,
        }),
      );
      if (!authorized) forgetVisibleEvent(eventId);
      return authorized;
    },
    settle: async (context, eventId, claimedAt, status, now) => {
      const acknowledged = booleanResultSchema.parse(
        await command(context.userId, {
          operation: 'settle',
          eventId,
          claimedAt,
          status,
          now: now.toISOString(),
        }),
      );
      if (status !== 'delivered' || !acknowledged) forgetVisibleEvent(eventId);
      return acknowledged;
    },
    getDeliveredEvent: async (userId, eventId, now) => {
      const result = await command(userId, {
        operation: 'get-click',
        eventId,
        now: now.toISOString(),
      });
      if (result === null) return null;
      const event = notificationEventSchema.parse(result);
      return event;
    },
    authorizeClick: async (userId, eventId, now) => {
      const result = await command(userId, {
        operation: 'authorize-click',
        eventId,
        now: now.toISOString(),
      });
      return result === null ? null : safeRouteSchema.parse(result);
    },
    getPermission: async (context) =>
      notificationPermissionSchema.parse(
        await command(context.userId, { operation: 'get-permission' }),
      ),
    setPermission: async (context, state) => {
      await command(context.userId, {
        operation: 'set-permission',
        permission: state,
      });
      if (state === 'denied' || state === 'unsupported')
        await dismissAccount(context.userId);
    },
    setFocus: async (context, isFocused) => {
      await command(context.userId, { operation: 'set-focus', isFocused });
    },
    clearAccount: async (context) => {
      await command(context.userId, { operation: 'clear-account' });
      await dismissAccount(context.userId);
    },
  };

  const delivery = createNotificationDelivery(
    {
      ...dependencies,
      isFocused: () => focusedOverride ?? dependencies.isFocused(),
      show: async (notification) => {
        if (disposed) return 'failed';
        const result = await dependencies.show(notification);
        if (result === 'shown') {
          const userId = eventOwners.get(notification.eventId);
          if (userId) {
            const eventIds = visibleEventsByAccount.get(userId) ?? new Set();
            eventIds.add(notification.eventId);
            visibleEventsByAccount.set(userId, eventIds);
          }
        }
        return result;
      },
      dismiss: async (eventId) => {
        try {
          await dependencies.dismiss?.(eventId);
        } finally {
          forgetVisibleEvent(eventId);
        }
      },
    },
    persistence,
  );

  const deliverDueNotifications = async (context: AuthorizedContext) => {
    if (disposed || !context.isCurrent()) return;
    if (activeDeliveryRun) {
      if (activeDeliveryContext === context) return activeDeliveryRun;
      await activeDeliveryRun.catch(() => undefined);
      if (disposed || !context.isCurrent()) return;
      return deliverDueNotifications(context);
    }
    activeDeliveryContext = context;
    activeContext = context;
    const deliveryContext: AuthorizedContext = {
      ...context,
      isCurrent: () => !disposed && context.isCurrent(),
    };
    const currentRun = Promise.resolve().then(async () => {
      await Promise.all(pendingOperations);
      if (!disposed && deliveryContext.isCurrent())
        await delivery.deliverDueNotifications(deliveryContext);
    });
    activeDeliveryRun = currentRun;
    try {
      await currentRun;
    } finally {
      if (activeDeliveryRun === currentRun) {
        activeDeliveryRun = null;
        activeDeliveryContext = null;
      }
    }
  };

  const setFocus = (
    context: AuthorizedContext,
    isFocused: boolean,
  ): Promise<void> => {
    if (disposed || !context.isCurrent()) return Promise.resolve();
    focusedOverride = isFocused;
    return scheduleOperation(
      Promise.resolve(delivery.setFocus(context, isFocused)),
    );
  };

  const setPermission = (
    context: AuthorizedContext,
    state: NotificationPermission,
  ): Promise<void> => {
    if (disposed || !context.isCurrent()) return Promise.resolve();
    return scheduleOperation(
      Promise.resolve(delivery.setPermission(context, state)),
    );
  };

  const clearAccount = (context: AuthorizedContext): Promise<void> => {
    if (disposed || !context.isCurrent()) return Promise.resolve();
    if (activeContext?.userId === context.userId) activeContext = null;
    const activeRun =
      activeDeliveryContext?.userId === context.userId
        ? activeDeliveryRun
        : null;
    return scheduleAccountCleanup(
      Promise.resolve(delivery.clearAccount(context)).then(async () => {
        await activeRun?.catch(() => undefined);
      }),
    );
  };

  const handleClick = (userId: string, eventId: string): Promise<boolean> =>
    disposed ||
    !activeContext ||
    activeContext.userId !== userId ||
    !activeContext.isCurrent()
      ? Promise.resolve(false)
      : delivery.handleClick(userId, eventId);

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    activeContext = null;
    await Promise.allSettled([...pendingOperations, ...pendingAccountCleanups]);
    await activeDeliveryRun?.catch(() => undefined);
  };

  return {
    deliverDueNotifications,
    handleClick,
    setFocus,
    setPermission,
    clearAccount,
    dispose,
  };
};
