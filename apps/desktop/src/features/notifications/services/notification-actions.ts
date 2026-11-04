import { z } from 'zod';
import {
  idSchema,
  instantSchema,
  type AuthorizedContext,
  type AuthorizedRegistrar,
  type InputOf,
  type SafeErrorCode,
} from '@scholaros/services/learning/product-contracts';
import {
  notificationCategories,
  notificationSettingsSchema,
  notificationTargetKinds,
  safeRouteSchema,
} from '@scholaros/services/learning/notification-contracts';
import type {
  NotificationSettings,
  NotificationStatus,
  NotificationTargetKind,
} from '@scholaros/services/learning/notification-contracts';
import {
  authorizeNotificationClickForUser,
  cancelNotificationEventsForUser,
  claimNotificationEventsForUser,
  enqueueNotificationEventForUser,
  getNotificationEventForUser,
  getNotificationEventsForUser,
  getNotificationSettingsForUser,
  saveNotificationSettingsForUser,
  authorizeNotificationShowForUser,
  settleNotificationEventForUser,
} from './notification-store';
import { notificationPermissionStates } from './notification-policy';
import type { NotificationPermission } from './notification-policy';

export const notificationOutcomeKinds = [
  'completed',
  'failed',
  'attention',
] as const;
export type NotificationOutcomeKind = (typeof notificationOutcomeKinds)[number];
const notificationOutcomeSchema = z.strictObject({
  category: z.enum(notificationCategories),
  outcome: z.enum(notificationOutcomeKinds),
  outcomeId: idSchema,
  targetKind: z.enum(notificationTargetKinds),
  targetId: idSchema.nullable(),
  route: safeRouteSchema,
  expiresAt: instantSchema,
});
export type NotificationOutcomeSchema = z.infer<
  typeof notificationOutcomeSchema
>;
export type NotificationOutcome = NotificationOutcomeSchema;

const permissionStateSchema = z.enum(notificationPermissionStates);
export type PermissionStateSchema = z.infer<typeof permissionStateSchema>;
const saveSettingsInputSchema = z.strictObject({
  settings: notificationSettingsSchema.omit({ revision: true }),
  expectedRevision: z.number().int().nonnegative().safe(),
});
export type SaveSettingsInputSchema = z.infer<typeof saveSettingsInputSchema>;
const cancelTargetSchema = z.strictObject({
  targetKind: z.enum(notificationTargetKinds).optional(),
  targetId: idSchema.nullable().optional(),
});
export type CancelTargetSchema = z.infer<typeof cancelTargetSchema>;
const notificationDeliveryCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('claim'),
    userId: idSchema,
    now: instantSchema,
    isFocused: z.boolean(),
  }),
  z.strictObject({
    operation: z.literal('authorize-show'),
    userId: idSchema,
    eventId: idSchema,
    claimedAt: instantSchema,
    now: instantSchema,
    isFocused: z.boolean(),
  }),
  z.strictObject({
    operation: z.literal('settle'),
    userId: idSchema,
    eventId: idSchema,
    claimedAt: instantSchema,
    status: z.enum(['delivered', 'failed', 'cancelled']),
    now: instantSchema,
  }),
  z.strictObject({
    operation: z.literal('get-click'),
    userId: idSchema,
    eventId: idSchema,
    now: instantSchema,
  }),
  z.strictObject({
    operation: z.literal('authorize-click'),
    userId: idSchema,
    eventId: idSchema,
    now: instantSchema,
  }),
  z.strictObject({
    operation: z.literal('set-focus'),
    userId: idSchema,
    isFocused: z.boolean(),
  }),
  z.strictObject({
    operation: z.literal('set-permission'),
    userId: idSchema,
    permission: permissionStateSchema,
  }),
  z.strictObject({ operation: z.literal('get-permission'), userId: idSchema }),
  z.strictObject({ operation: z.literal('clear-account'), userId: idSchema }),
]);
export type NotificationDeliveryCommand = z.infer<
  typeof notificationDeliveryCommandSchema
>;

const permissionStates = new Map<string, NotificationPermission>();
const focusedAccountStates = new Map<string, boolean>();
const createNotificationError = (code: SafeErrorCode, message: string = code) =>
  Object.assign(new Error(message), { code });
const requireCurrentContext = (context: AuthorizedContext) => {
  if (!context.isCurrent())
    throw createNotificationError(
      'session-changed',
      'Your account changed; reopen Settings and try again.',
    );
};

const isValidOutcomeTarget = (event: NotificationOutcome) => {
  switch (event.category) {
    case 'connection-attention':
      return event.outcome === 'attention' && event.targetKind === 'connection';
    case 'sync-completed':
      return (
        event.outcome === 'completed' &&
        ['course', 'connection', 'device'].includes(event.targetKind)
      );
    case 'sync-failed':
      return (
        event.outcome === 'failed' &&
        ['course', 'connection', 'device'].includes(event.targetKind)
      );
    case 'context-completed':
      return event.outcome === 'completed' && event.targetKind === 'context';
    case 'context-failed':
      return event.outcome === 'failed' && event.targetKind === 'context';
    case 'tutor-ready':
    case 'activity-ready':
    case 'timer-expired':
      return event.outcome === 'completed' && event.targetKind === 'study';
    case 'deadline-reminder':
      return event.outcome === 'attention' && event.targetKind === 'course';
  }
};

const isValidRouteForTarget = (event: NotificationOutcome) => {
  switch (event.targetKind) {
    case 'context':
      return (
        event.route.kind === 'context' && event.route.itemId === event.targetId
      );
    case 'study':
      return (
        event.route.kind === 'study' && event.route.sessionId === event.targetId
      );
    case 'course':
      return (
        event.route.kind === 'course' && event.route.courseId === event.targetId
      );
    case 'connection':
      return (
        event.targetId !== null &&
        (event.route.kind === 'today' ||
          (event.route.kind === 'settings' &&
            event.route.section === 'connections'))
      );
    case 'device':
      return (
        event.targetId === null &&
        (event.route.kind === 'today' ||
          (event.route.kind === 'settings' && event.route.section === 'device'))
      );
  }
};

export const setNotificationPermissionState = (
  context: AuthorizedContext,
  state: NotificationPermission,
) => {
  requireCurrentContext(context);
  const parsedState = permissionStateSchema.parse(state);
  permissionStates.set(context.userId, parsedState);
  if (parsedState === 'denied' || parsedState === 'unsupported')
    cancelNotificationEventsForUser(context.userId);
};

export const setNotificationFocusState = (
  context: AuthorizedContext,
  isFocused: boolean,
) => {
  requireCurrentContext(context);
  focusedAccountStates.set(context.userId, isFocused);
};

export const clearNotificationPermissionState = (
  context: AuthorizedContext,
) => {
  requireCurrentContext(context);
  permissionStates.delete(context.userId);
  focusedAccountStates.delete(context.userId);
  cancelNotificationEventsForUser(context.userId);
};

export const getNotificationPermissionState = (
  context: AuthorizedContext,
): NotificationPermission => {
  requireCurrentContext(context);
  return permissionStates.get(context.userId) ?? 'unknown';
};

export const getNotificationSettings = async (
  context: AuthorizedContext,
): Promise<NotificationSettings> => {
  requireCurrentContext(context);
  const settings = getNotificationSettingsForUser(context.userId);
  requireCurrentContext(context);
  if (!settings)
    throw createNotificationError(
      'storage-failed',
      'Notification settings are unavailable.',
    );
  return settings;
};

export const saveNotificationSettings = async (
  context: AuthorizedContext,
  input: InputOf<'saveNotificationSettings'>,
): Promise<NotificationSettings> => {
  requireCurrentContext(context);
  const parsedInput = saveSettingsInputSchema.parse(input);
  const currentSettings = getNotificationSettingsForUser(context.userId);
  if (!currentSettings)
    throw createNotificationError(
      'storage-failed',
      'Notification settings are unavailable.',
    );
  if (
    parsedInput.settings.enabled &&
    !currentSettings.enabled &&
    permissionStates.get(context.userId) !== 'granted'
  )
    throw createNotificationError(
      'permission-revoked',
      'Allow notifications in system settings before enabling alerts.',
    );
  const updatedSettings = saveNotificationSettingsForUser(
    context.userId,
    parsedInput,
  );
  requireCurrentContext(context);
  return updatedSettings;
};

export const enqueueProductNotification = async (
  context: AuthorizedContext,
  input: NotificationOutcome,
): Promise<{
  eventId: string;
  status: NotificationStatus;
  created: boolean;
}> => {
  requireCurrentContext(context);
  const event = notificationOutcomeSchema.parse(input);
  if (!isValidOutcomeTarget(event) || !isValidRouteForTarget(event))
    throw createNotificationError(
      'invalid-input',
      'This notification outcome is not supported.',
    );
  const now = new Date();
  const permission = permissionStates.get(context.userId) ?? 'unknown';
  const isFocused = focusedAccountStates.get(context.userId) ?? false;
  requireCurrentContext(context);
  const insertedNotification = enqueueNotificationEventForUser(
    context.userId,
    {
      category: event.category,
      targetKind: event.targetKind,
      targetId: event.targetId,
      outcomeId: event.outcomeId,
      expiresAt: event.expiresAt,
      safeRoute: event.route,
    },
    { now, isFocused, permission },
  );
  requireCurrentContext(context);
  return {
    eventId: insertedNotification.event.id,
    status: insertedNotification.event.status,
    created: insertedNotification.created,
  };
};

export const claimDueNotifications = async (
  context: AuthorizedContext,
  options: { now?: Date; isFocused: boolean },
) => {
  requireCurrentContext(context);
  const claimedNotifications = claimNotificationEventsForUser(context.userId, {
    now: options.now ?? new Date(),
    isFocused: options.isFocused,
    permission: permissionStates.get(context.userId) ?? 'unknown',
  });
  requireCurrentContext(context);
  return claimedNotifications;
};

const handleNotificationDeliveryCommand = async (
  context: AuthorizedContext,
  input: unknown,
) => {
  requireCurrentContext(context);
  const command = notificationDeliveryCommandSchema.parse(input);
  if (command.userId !== context.userId)
    throw createNotificationError('session-changed');
  switch (command.operation) {
    case 'claim':
      return claimDueNotifications(context, {
        now: new Date(command.now),
        isFocused: command.isFocused,
      });
    case 'authorize-show':
      return authorizeNotificationShowForUser(
        context.userId,
        command.eventId,
        command.claimedAt,
        {
          now: new Date(command.now),
          isFocused: command.isFocused,
          permission: permissionStates.get(context.userId) ?? 'unknown',
        },
      );
    case 'settle':
      return settleNotificationEventForUser(
        context.userId,
        command.eventId,
        command.claimedAt,
        command.status,
        new Date(command.now),
      );
    case 'get-click': {
      const event = getNotificationEventForUser(
        context.userId,
        command.eventId,
      );
      return event?.status === 'delivered' &&
        Date.parse(event.expiresAt) > Date.parse(command.now)
        ? event
        : null;
    }
    case 'authorize-click':
      return authorizeNotificationClickForUser(
        context.userId,
        command.eventId,
        new Date(command.now),
      );
    case 'set-focus':
      return setNotificationFocusState(context, command.isFocused);
    case 'set-permission':
      return setNotificationPermissionState(context, command.permission);
    case 'get-permission':
      return getNotificationPermissionState(context);
    case 'clear-account':
      return clearNotificationPermissionState(context);
  }
};

export type NotificationDeliveryCommandResult = Awaited<
  ReturnType<typeof handleNotificationDeliveryCommand>
>;
export type NotificationInternalMethodContracts = {
  claimDueNotifications: {
    input: NotificationDeliveryCommand;
    result: NotificationDeliveryCommandResult;
  };
};
export type NotificationActionRegistrar = AuthorizedRegistrar & {
  handleInternal<Method extends keyof NotificationInternalMethodContracts>(
    name: Method,
    handler: (
      context: AuthorizedContext,
      input: NotificationInternalMethodContracts[Method]['input'],
    ) => Promise<NotificationInternalMethodContracts[Method]['result']>,
  ): void;
};

export const cancelNotificationsForTarget = async (
  context: AuthorizedContext,
  input?: { targetKind: NotificationTargetKind; targetId: string | null },
): Promise<void> => {
  requireCurrentContext(context);
  if (input) {
    const parsedTarget = cancelTargetSchema.parse(input);
    if (!parsedTarget.targetKind || parsedTarget.targetId === undefined)
      throw createNotificationError(
        'invalid-input',
        'Select a valid notification target.',
      );
    cancelNotificationEventsForUser(context.userId, {
      targetKind: parsedTarget.targetKind,
      targetId: parsedTarget.targetId,
    });
  } else {
    cancelNotificationEventsForUser(context.userId);
  }
};

export const registerNotificationActions = (
  registrar: NotificationActionRegistrar,
): (() => Promise<void>) => {
  registrar.handle('getNotificationSettings', getNotificationSettings);
  registrar.handle('saveNotificationSettings', async (context, input) => {
    const updatedSettings = await saveNotificationSettings(context, input);
    if (context.isCurrent())
      registrar.publish({
        version: 1,
        accountId: context.userId,
        revision: updatedSettings.revision,
        resource: 'notifications',
        targetId: null,
      });
    return updatedSettings;
  });
  registrar.handleInternal(
    'claimDueNotifications',
    handleNotificationDeliveryCommand,
  );
  return async () => {
    permissionStates.clear();
    focusedAccountStates.clear();
  };
};

export const getNotificationsForAccount = (userId: string) =>
  getNotificationEventsForUser(userId);
