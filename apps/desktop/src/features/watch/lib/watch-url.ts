import {
  isAcademicUrl,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import { maxWatchUrlLength } from '../constants';
import type {
  ParsedWatchUrl,
  WatchConnection,
  WatchSettings,
  WatchTargetUpsert,
} from '../types';

const containsControlCharacters = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });

export const parseWatchUrl = (
  input: string,
  connections: readonly WatchConnection[],
): ParsedWatchUrl => {
  if (input.length > maxWatchUrlLength)
    throw new Error('Course page URLs must be 2,048 characters or fewer.');
  if (/[\r\n]/.test(input))
    throw new Error('Add one course page URL at a time.');
  const value = input.trim();
  if (!value || containsControlCharacters(value))
    throw new Error('Enter one valid HTTPS course page URL.');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter one valid HTTPS course page URL.');
  }
  if (url.username || url.password)
    throw new Error('Course page URLs cannot contain sign-in credentials.');
  if (!isAcademicUrl(url.href))
    throw new Error('Use a secure public HTTPS course page URL.');

  const connection = connections.find(
    (candidate) =>
      candidate.isCourseResource &&
      candidate.host.toLowerCase() === url.hostname.toLowerCase(),
  );
  if (!connection)
    throw new Error('Connect this resource before adding its URL.');
  if (!isReadNavigation(url.href, [connection.host]))
    throw new Error('This URL cannot be watched safely.');

  const identity = url.href;
  if (identity.length > maxWatchUrlLength)
    throw new Error('Course page URLs must be 2,048 characters or fewer.');
  return { url: identity, identity, connectionId: connection.id };
};

export const getEffectiveWatchTargetInputs = (
  settings: WatchSettings,
  connections: readonly (WatchConnection & {
    url: string;
    status?: 'verified' | 'confirmed' | 'needs-sign-in';
  })[],
): WatchTargetUpsert[] => {
  if (!settings.watchEnabled) return [];
  const eligibleConnections = connections.filter(
    (connection) =>
      connection.isCourseResource && connection.status !== 'needs-sign-in',
  );
  const urls = settings.watchUrls.length
    ? settings.watchUrls.map((url) => ({ url, courseId: null }))
    : eligibleConnections.map((connection) => ({
        url: connection.url,
        courseId: null,
      }));
  return urls.flatMap(({ url, courseId }) => {
    try {
      const parsedUrl = parseWatchUrl(url, eligibleConnections);
      return [
        {
          connectionId: parsedUrl.connectionId,
          courseId,
          requestedUrl: parsedUrl.url,
          recipeVersion: 1,
        },
      ];
    } catch {
      return [];
    }
  });
};
