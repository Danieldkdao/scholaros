import { safeRouteSchema } from '@scholaros/services/learning/notification-contracts';
import type {
  NotificationStatus,
  SafeRoute,
} from '@scholaros/services/learning/notification-contracts';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import type { NotificationEventSelectData } from '../../../db/schema';
import type { NotificationPermission } from './notification-policy';
import { formatNotificationCopy } from '../lib/formatters';

export type NativeNotificationDisplay = {
  eventId: string;
  title: string;
  body: string;
  onClick: () => Promise<boolean>;
};

export type NotificationDeliveryDependencies = {
  isFocused: () => boolean;
  show: (
    notification: NativeNotificationDisplay,
  ) => Promise<'shown' | 'failed'>;
  dismiss?: (eventId: string) => void | Promise<void>;
  route: (route: SafeRoute) => void | Promise<void>;
  validateTarget: (
    userId: string,
    event: NotificationEventSelectData,
  ) => boolean | Promise<boolean>;
  permission?: (
    userId: string,
  ) => NotificationPermission | Promise<NotificationPermission>;
  now?: () => Date;
};

type Awaitable<TResult> = TResult | Promise<TResult>;
type NotificationDeliveryPolicyContext = {
  now: Date;
  isFocused: boolean;
};
export type NotificationDeliveryPersistence = {
  claim: (
    context: AuthorizedContext,
    options: NotificationDeliveryPolicyContext,
  ) => Awaitable<NotificationEventSelectData[]>;
  authorizeShow: (
    context: AuthorizedContext,
    eventId: string,
    claimedAt: string,
    options: NotificationDeliveryPolicyContext & {
      permission: NotificationPermission;
    },
  ) => Awaitable<boolean>;
  settle: (
    context: AuthorizedContext,
    eventId: string,
    claimedAt: string,
    status: Extract<NotificationStatus, 'delivered' | 'failed' | 'cancelled'>,
    now: Date,
  ) => Awaitable<boolean>;
  getDeliveredEvent: (
    userId: string,
    eventId: string,
    now: Date,
  ) => Awaitable<NotificationEventSelectData | null>;
  authorizeClick: (
    userId: string,
    eventId: string,
    now: Date,
  ) => Awaitable<SafeRoute | null>;
  getPermission: (
    context: AuthorizedContext,
  ) => Awaitable<NotificationPermission>;
  setPermission: (
    context: AuthorizedContext,
    state: NotificationPermission,
  ) => Awaitable<void>;
  setFocus: (context: AuthorizedContext, isFocused: boolean) => Awaitable<void>;
  clearAccount: (context: AuthorizedContext) => Awaitable<void>;
};

const localNotificationPersistence: NotificationDeliveryPersistence = {
  claim: async (context, options) => {
    const { claimDueNotifications } = await import('./notification-actions');
    return claimDueNotifications(context, options);
  },
  authorizeShow: async (context, eventId, claimedAt, options) => {
    const { authorizeNotificationShowForUser } =
      await import('./notification-store');
    const { getNotificationPermissionState } =
      await import('./notification-actions');
    return authorizeNotificationShowForUser(
      context.userId,
      eventId,
      claimedAt,
      {
        ...options,
        permission: getNotificationPermissionState(context),
      },
    );
  },
  settle: async (context, eventId, claimedAt, status, now) => {
    const { settleNotificationEventForUser } =
      await import('./notification-store');
    return settleNotificationEventForUser(
      context.userId,
      eventId,
      claimedAt,
      status,
      now,
    );
  },
  getDeliveredEvent: async (userId, eventId, now) => {
    const { getNotificationEventForUser } =
      await import('./notification-store');
    const event = getNotificationEventForUser(userId, eventId);
    return event?.status === 'delivered' &&
      Date.parse(event.expiresAt) > now.getTime()
      ? event
      : null;
  },
  authorizeClick: async (userId, eventId, now) => {
    const { authorizeNotificationClickForUser } =
      await import('./notification-store');
    return authorizeNotificationClickForUser(userId, eventId, now);
  },
  getPermission: async (context) => {
    const { getNotificationPermissionState } =
      await import('./notification-actions');
    return getNotificationPermissionState(context);
  },
  setPermission: async (context, state) => {
    const { setNotificationPermissionState } =
      await import('./notification-actions');
    setNotificationPermissionState(context, state);
  },
  setFocus: async (context, isFocused) => {
    const { setNotificationFocusState } =
      await import('./notification-actions');
    setNotificationFocusState(context, isFocused);
  },
  clearAccount: async (context) => {
    const { clearNotificationPermissionState } =
      await import('./notification-actions');
    clearNotificationPermissionState(context);
  },
};

const safeRoutesMatch = (left: SafeRoute, right: SafeRoute): boolean => {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'today':
      return right.kind === 'today';
    case 'settings':
      return right.kind === 'settings' && left.section === right.section;
    case 'course':
      return right.kind === 'course' && left.courseId === right.courseId;
    case 'context':
      return right.kind === 'context' && left.itemId === right.itemId;
    case 'study':
      return right.kind === 'study' && left.sessionId === right.sessionId;
  }
};

export const createNotificationDelivery = (
  dependencies: NotificationDeliveryDependencies,
  persistence: NotificationDeliveryPersistence = localNotificationPersistence,
) => {
  const now = dependencies.now ?? (() => new Date());
  let activeContext: AuthorizedContext | null = null;

  const isActiveContext = (context: AuthorizedContext, userId: string) =>
    activeContext === context &&
    context.userId === userId &&
    context.isCurrent();

  const currentPermission = async (
    context: AuthorizedContext,
  ): Promise<NotificationPermission> => {
    if (!dependencies.permission) return persistence.getPermission(context);
    const permission = await dependencies.permission(context.userId);
    if (context.isCurrent())
      await persistence.setPermission(context, permission);
    return permission;
  };

  const settle = async (
    context: AuthorizedContext,
    event: NotificationEventSelectData,
    status: Extract<NotificationStatus, 'delivered' | 'failed' | 'cancelled'>,
  ): Promise<boolean> => {
    if (!event.claimedAt) return false;
    try {
      return await persistence.settle(
        context,
        event.id,
        event.claimedAt,
        status,
        now(),
      );
    } catch {
      return false;
    }
  };

  const handleClick = async (
    userId: string,
    eventId: string,
    suppliedContext?: AuthorizedContext,
  ): Promise<boolean> => {
    const context = suppliedContext ?? activeContext;
    if (context && !isActiveContext(context, userId)) return false;
    if (!context && persistence === localNotificationPersistence) return false;
    const isCurrent = () => !context || isActiveContext(context, userId);
    try {
      const event = await persistence.getDeliveredEvent(userId, eventId, now());
      if (
        !isCurrent() ||
        !event ||
        event.userId !== userId ||
        event.status !== 'delivered' ||
        Date.parse(event.expiresAt) <= now().getTime()
      )
        return false;
      const route = safeRouteSchema.safeParse(event.safeRoute);
      if (!route.success) return false;
      if (!(await dependencies.validateTarget(userId, event))) return false;
      if (!isCurrent()) return false;
      const authorizedRoute = safeRouteSchema.safeParse(
        await persistence.authorizeClick(userId, eventId, now()),
      );
      if (
        !isCurrent() ||
        !authorizedRoute.success ||
        !safeRoutesMatch(route.data, authorizedRoute.data)
      )
        return false;
      if (
        !(await dependencies.validateTarget(userId, {
          ...event,
          safeRoute: authorizedRoute.data,
        })) ||
        !isCurrent()
      )
        return false;
      await dependencies.route(authorizedRoute.data);
      return true;
    } catch {
      return false;
    }
  };

  const deliverDueNotifications = async (context: AuthorizedContext) => {
    if (!context.isCurrent()) return;
    activeContext = context;
    let permission: NotificationPermission;
    try {
      await persistence.setFocus(context, dependencies.isFocused());
      permission = await currentPermission(context);
    } catch {
      return;
    }
    if (!context.isCurrent()) return;
    const claimedNotifications = await persistence.claim(context, {
      now: now(),
      isFocused: dependencies.isFocused(),
    });

    for (const event of claimedNotifications) {
      if (!event.claimedAt) continue;
      if (!context.isCurrent()) {
        await settle(context, event, 'cancelled');
        continue;
      }
      let targetAvailable = false;
      try {
        targetAvailable = await dependencies.validateTarget(
          context.userId,
          event,
        );
      } catch {
        targetAvailable = false;
      }
      if (!context.isCurrent()) {
        await settle(context, event, 'cancelled');
        continue;
      }
      if (!targetAvailable) {
        await settle(context, event, 'cancelled');
        continue;
      }
      try {
        permission = await currentPermission(context);
      } catch {
        await settle(context, event, 'cancelled');
        continue;
      }
      if (!context.isCurrent()) {
        await settle(context, event, 'cancelled');
        continue;
      }
      let authorized = false;
      try {
        authorized = await persistence.authorizeShow(
          context,
          event.id,
          event.claimedAt,
          {
            now: now(),
            isFocused: dependencies.isFocused(),
            permission,
          },
        );
      } catch {
        await settle(context, event, 'cancelled');
        continue;
      }
      if (!authorized) continue;
      if (!context.isCurrent()) {
        await settle(context, event, 'cancelled');
        continue;
      }
      const copy = formatNotificationCopy(event.category);
      let result: 'shown' | 'failed' = 'failed';
      try {
        result = await dependencies.show({
          eventId: event.id,
          title: copy.title,
          body: copy.body,
          onClick: () => handleClick(event.userId, event.id, context),
        });
      } catch {
        result = 'failed';
      }
      const isCurrent = context.isCurrent();
      const settled = await settle(
        context,
        event,
        isCurrent ? (result === 'shown' ? 'delivered' : 'failed') : 'cancelled',
      );
      if (result === 'shown' && (!isCurrent || !settled)) {
        try {
          await dependencies.dismiss?.(event.id);
        } catch {
          // Dismissal is best-effort; the persisted event remains terminal.
        }
      }
    }
  };

  const clearAccount = async (context: AuthorizedContext) => {
    if (activeContext?.userId === context.userId) activeContext = null;
    await persistence.clearAccount(context);
  };

  return {
    deliverDueNotifications,
    handleClick,
    setFocus: persistence.setFocus,
    setPermission: persistence.setPermission,
    clearAccount,
  };
};
