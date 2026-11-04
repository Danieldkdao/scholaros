import {
  courseDiscoverySchema,
  navigationDecisionSchema,
} from '@scholaros/services/ai/schemas';
import { accountRequest } from '../../../lib/auth/main';
import type {
  BrowserNavigationAdapter,
  BrowserNavigationDependencies,
  ResourceExtractionRequest,
} from './browser-navigation';

export const createDecisionNavigationAdapter = ({
  signal,
  isCurrent,
  assertReadable,
}: BrowserNavigationDependencies): BrowserNavigationAdapter => ({
  discoverCourses: async ({ goal, notes, pages, targets }) => {
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    assertReadable();
    const result = await accountRequest(
      '/api/agent',
      {
        kind: 'discover',
        browserNavigationMode: 'decision',
        goal,
        notes,
        pages,
        targets,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    assertReadable();
    const selection = courseDiscoverySchema.parse(result);
    if (
      selection.courseTargetIds.some(
        (id) => !targets.some((target) => target.id === id),
      )
    )
      throw new Error('The decision model selected an unoffered course.');
    return selection.courseTargetIds;
  },
  choose: async ({ goal, notes, pages, targets, memory }) => {
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    assertReadable();
    const result = await accountRequest(
      '/api/agent',
      {
        kind: 'choose',
        browserNavigationMode: 'decision',
        goal,
        notes,
        pages,
        targets,
        ...(memory ? { memory } : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    assertReadable();
    const choice = navigationDecisionSchema.parse(result);
    if (
      choice.operation === 'NAVIGATE' &&
      !targets.some((target) => target.id === choice.target)
    )
      throw new Error('The decision model selected an unoffered page.');
    return {
      operation: choice.operation,
      target: choice.operation === 'NAVIGATE' ? choice.target : null,
    };
  },
  extract: async (request: ResourceExtractionRequest) => {
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    assertReadable();
    const result = await accountRequest(
      '/api/agent',
      { ...request, browserNavigationMode: 'decision' },
      signal,
    );
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    assertReadable();
    return result;
  },
});
