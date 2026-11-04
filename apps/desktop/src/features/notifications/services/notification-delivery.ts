import { safeRouteSchema } from '@scholaros/services/learning/notification-contracts';
import type { NotificationEventSelectData } from '../../../db/schema';
import type { SafeRoute } from '@scholaros/services/learning/notification-contracts';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import {
  claimDueNotifications,
  getNotificationPermissionState,
  setNotificationPermissionState,
} from './notification-actions';
import type { NotificationPermission } from './notification-policy';
import {
  authorizeNotificationShowForUser,
  getNotificationEventForUser,
  getNotificationSettingsForUser,
  isNotificationTargetAvailable,
  settleNotificationEventForUser,
} from './notification-store';
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

export const createNotificationDelivery = (
  dependencies: NotificationDeliveryDependencies,
) => {
  const now = dependencies.now ?? (() => new Date());

  const currentPermission = async (
    context: AuthorizedContext,
  ): Promise<NotificationPermission> => {
    if (!dependencies.permission)
      return getNotificationPermissionState(context);
    const permission = await dependencies.permission(context.userId);
    if (context.isCurrent())
      setNotificationPermissionState(context, permission);
    return permission;
  };

  const handleClick = async (
    userId: string,
    eventId: string,
  ): Promise<boolean> => {
    const event = getNotificationEventForUser(userId, eventId);
    if (
      !event ||
      event.status !== 'delivered' ||
      Date.parse(event.expiresAt) <= now().getTime()
    )
      return false;
    const route = safeRouteSchema.safeParse(event.safeRoute);
    const settings = getNotificationSettingsForUser(userId);
    if (
      !route.success ||
      !settings?.enabled ||
      !settings.categories[event.category] ||
      !isNotificationTargetAvailable(userId, event)
    )
      return false;
    try {
      if (!(await dependencies.validateTarget(userId, event))) return false;
      const latestEvent = getNotificationEventForUser(userId, eventId);
      const latestSettings = getNotificationSettingsForUser(userId);
      if (
        !latestEvent ||
        latestEvent.status !== 'delivered' ||
        Date.parse(latestEvent.expiresAt) <= now().getTime() ||
        !latestSettings?.enabled ||
        !latestSettings.categories[latestEvent.category] ||
        !isNotificationTargetAvailable(userId, latestEvent)
      )
        return false;
      await dependencies.route(route.data);
      return true;
    } catch {
      return false;
    }
  };

  const deliverDueNotifications = async (context: AuthorizedContext) => {
    if (!context.isCurrent()) return;
    let permission: NotificationPermission;
    try {
      permission = await currentPermission(context);
    } catch {
      return;
    }
    if (!context.isCurrent()) return;
    const claimedNotifications = await claimDueNotifications(context, {
      now: now(),
      isFocused: dependencies.isFocused(),
    });

    for (const event of claimedNotifications) {
      if (!context.isCurrent()) {
        settleNotificationEventForUser(
          context.userId,
          event.id,
          'cancelled',
          now(),
        );
        continue;
      }
      let targetAvailable = false;
      try {
        targetAvailable =
          isNotificationTargetAvailable(context.userId, event) &&
          (await dependencies.validateTarget(context.userId, event));
      } catch {
        targetAvailable = false;
      }
      if (!context.isCurrent()) {
        settleNotificationEventForUser(
          context.userId,
          event.id,
          'cancelled',
          now(),
        );
        continue;
      }
      if (!targetAvailable) {
        settleNotificationEventForUser(
          context.userId,
          event.id,
          'cancelled',
          now(),
        );
        continue;
      }
      try {
        permission = await currentPermission(context);
      } catch {
        settleNotificationEventForUser(
          context.userId,
          event.id,
          'cancelled',
          now(),
        );
        continue;
      }
      if (!context.isCurrent()) {
        settleNotificationEventForUser(
          context.userId,
          event.id,
          'cancelled',
          now(),
        );
        continue;
      }
      const authorized = authorizeNotificationShowForUser(
        context.userId,
        event.id,
        {
          now: now(),
          isFocused: dependencies.isFocused(),
          permission,
        },
      );
      if (!authorized) continue;
      const copy = formatNotificationCopy(event.category);
      let result: 'shown' | 'failed' = 'failed';
      try {
        result = await dependencies.show({
          eventId: event.id,
          title: copy.title,
          body: copy.body,
          onClick: () => handleClick(event.userId, event.id),
        });
      } catch {
        result = 'failed';
      }
      const isCurrent = context.isCurrent();
      const settled = settleNotificationEventForUser(
        context.userId,
        event.id,
        isCurrent ? (result === 'shown' ? 'delivered' : 'failed') : 'cancelled',
        now(),
      );
      if (result === 'shown' && (!isCurrent || !settled)) {
        try {
          await dependencies.dismiss?.(event.id);
        } catch {
          // Dismissal is best-effort; the persisted event remains cancelled.
        }
      }
    }
  };

  return { deliverDueNotifications, handleClick };
};
