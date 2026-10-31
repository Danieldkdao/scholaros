import { connectionSuggestionsSchema } from '@scholaros/services/ai/schemas';
import { accountRequest } from '../../../lib/auth/main';
import { validateConnectionCandidates } from './connection-approval';

export const resolveConnectionCandidates = async (
  prompt: string,
  signal: AbortSignal,
) => {
  const response = await accountRequest(
    '/api/agent',
    { kind: 'resolve', prompt },
    signal,
  );
  if (!response) throw new Error('Please sign in to ScholarOS.');
  const result = connectionSuggestionsSchema.parse(response);
  return validateConnectionCandidates(result.candidates);
};
