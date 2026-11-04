import { expect, it, vi } from 'vitest';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import type { NotificationActionRegistrar } from '../services/notification-actions';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(
    join(tmpdir(), 'scholaros-notification-actions-'),
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

const { internalAcademicMethods, rendererAcademicMethods } =
  await import('../../../services/academic/contracts');
const { registerNotificationActions } =
  await import('../services/notification-actions');

const accountA = 'notification-action-account-a';
const accountB = 'notification-action-account-b';
const context: AuthorizedContext = {
  userId: accountA,
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
};

it('keeps delivery commands internal and rejects a mismatched account', async () => {
  const publicHandlers = new Map<
    string,
    (context: AuthorizedContext, input: unknown) => Promise<unknown>
  >();
  const internalHandlers = new Map<
    string,
    (context: AuthorizedContext, input: unknown) => Promise<unknown>
  >();
  const registrar = {
    handle: (name: string, handler: unknown) => {
      publicHandlers.set(
        name,
        handler as (
          context: AuthorizedContext,
          input: unknown,
        ) => Promise<unknown>,
      );
    },
    handleInternal: (name: string, handler: unknown) => {
      internalHandlers.set(
        name,
        handler as (
          context: AuthorizedContext,
          input: unknown,
        ) => Promise<unknown>,
      );
    },
    publish: vi.fn(),
  };
  const unregister = registerNotificationActions(
    registrar as unknown as NotificationActionRegistrar,
  );
  const commandHandler = internalHandlers.get('claimDueNotifications');

  expect(internalAcademicMethods).toContain('claimDueNotifications');
  expect(rendererAcademicMethods).not.toContain('claimDueNotifications');
  expect([...publicHandlers.keys()]).toEqual([
    'getNotificationSettings',
    'saveNotificationSettings',
  ]);
  expect(commandHandler).toBeDefined();
  await expect(
    commandHandler!(context, {
      operation: 'get-click',
      userId: accountB,
      eventId: 'notification-event-a',
      now: '2026-11-03T12:00:00.000Z',
    }),
  ).rejects.toMatchObject({ code: 'session-changed' });

  await unregister();
});
