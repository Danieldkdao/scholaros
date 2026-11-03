import type {
  ActionCleanup,
  AuthorizedContext,
  AuthorizedRegistrar,
  ProductEventV1,
} from '@scholaros/services/learning/product-contracts';
import { ContextStoreError, getContextRevision } from './library-store';
import {
  createContextNote,
  getContextItem,
  linkContextItem,
  listContextItems,
  removeContextItem,
  updateContextItem,
} from './library-store';

const publishContextChange = (
  registrar: AuthorizedRegistrar,
  context: AuthorizedContext,
  targetId: string,
) => {
  if (!context.isCurrent()) return;
  const revision = getContextRevision(context.userId);
  if (revision === null) return;
  const event: ProductEventV1 = {
    version: 1,
    accountId: context.userId,
    revision,
    resource: 'context',
    targetId,
    outcome: 'completed',
  };
  try {
    registrar.publish(event);
  } catch {
    // A persisted mutation remains successful if an invalidation subscriber is gone.
  }
};

export const registerContextActions = (
  registrar: AuthorizedRegistrar,
): ActionCleanup => {
  registrar.handle('listContextItems', async (context, input) => {
    const page = listContextItems(context, input);
    if (!page) throw new ContextStoreError('storage-failed');
    return page;
  });
  registrar.handle('getContextItem', async (context, input) => {
    const result = await getContextItem(context, input);
    if (!result) throw new ContextStoreError('not-found');
    return result;
  });
  registrar.handle('createContextNote', async (context, input) => {
    const createdContextItem = await createContextNote(context, input);
    publishContextChange(registrar, context, createdContextItem.id);
    return createdContextItem;
  });
  registrar.handle('updateContextItem', async (context, input) => {
    const updatedContextItem = await updateContextItem(context, input);
    publishContextChange(registrar, context, updatedContextItem.id);
    return updatedContextItem;
  });
  registrar.handle('linkContextItem', async (context, input) => {
    const linkedContextItem = await linkContextItem(context, input);
    publishContextChange(registrar, context, linkedContextItem.id);
    return linkedContextItem;
  });
  registrar.handle('removeContextItem', async (context, input) => {
    try {
      await removeContextItem(context, input);
    } catch (error) {
      if (error instanceof ContextStoreError && error.committed)
        publishContextChange(registrar, context, input.itemId);
      throw error;
    }
    publishContextChange(registrar, context, input.itemId);
  });
  return async () => {};
};
