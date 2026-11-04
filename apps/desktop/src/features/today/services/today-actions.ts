import type {
  ActionCleanup,
  AuthorizedRegistrar,
} from '@scholaros/services/learning/product-contracts';
import type {
  Recommendation,
  TodayOverview,
} from '@scholaros/services/learning/today-contracts';
import { getStudyRecommendations, getTodayOverview } from './today';

const readFailure = (label: string) =>
  Object.assign(new Error(label), { code: 'storage-failed' as const });

export const registerTodayActions = (
  registrar: AuthorizedRegistrar,
): ActionCleanup => {
  registrar.handle(
    'getTodayOverview',
    async (context, input): Promise<TodayOverview> => {
      const overview = getTodayOverview(context, input);
      if (!overview) throw readFailure('Today is temporarily unavailable.');
      return overview;
    },
  );
  registrar.handle(
    'getStudyRecommendations',
    async (context, input): Promise<Recommendation[]> => {
      const recommendations = getStudyRecommendations(context, input);
      if (!recommendations)
        throw readFailure('Study recommendations are temporarily unavailable.');
      return recommendations;
    },
  );
  return async () => undefined;
};
