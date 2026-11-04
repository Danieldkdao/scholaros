import { createHash } from 'node:crypto';
import type { WatchPageSnapshot } from '../types';

const normalizeText = (value: string) =>
  value
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeUrl = (value: string) => {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
};

export const createPageFingerprint = (snapshot: WatchPageSnapshot) => {
  const normalizedSnapshot = {
    url: normalizeUrl(snapshot.url),
    title: normalizeText(snapshot.title),
    text: normalizeText(snapshot.text),
    links: snapshot.links.map((link) => ({
      label: normalizeText(link.label),
      url: normalizeUrl(link.url),
      context: normalizeText(link.context),
    })),
    statuses: snapshot.statuses.map(normalizeText),
    complete: snapshot.complete,
    recipeVersion: snapshot.recipeVersion,
  };
  return createHash('sha256')
    .update(JSON.stringify(normalizedSnapshot))
    .digest('hex');
};
