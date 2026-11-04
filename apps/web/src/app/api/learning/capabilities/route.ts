import { getCurrentUser } from '@/lib/auth/helpers';
import { serverEnv } from '@/data/env/server';
import {
  learningCapabilitiesSchema,
  type LearningCapabilities,
} from '../../../../../../../packages/services/src/ai/learning-dispatch';
import { getLearningCapabilities } from '../../../../../../../packages/services/src/ai/tutor';

export const runtime = 'nodejs';
type CurrentUser = { userId: string | null } | null;
type LearningCapabilitiesDependencies = {
  getCurrentUser: (headers: Headers) => Promise<CurrentUser>;
  trustedOrigin: string;
  getCapabilities: () => Promise<LearningCapabilities>;
};
const noStore = { 'Cache-Control': 'no-store' };
const jsonError = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status, headers: noStore });

export const createLearningCapabilitiesHandler =
  (dependencies: LearningCapabilitiesDependencies) =>
  async (request: Request) => {
    const origin = request.headers.get('origin');
    if (origin && origin !== dependencies.trustedOrigin)
      return jsonError(
        403,
        'scope-denied',
        'The request origin is not allowed.',
      );
    const currentUser = await dependencies.getCurrentUser(request.headers);
    if (!currentUser?.userId)
      return jsonError(401, 'needs-sign-in', 'Sign in to use learning tools.');
    try {
      const capabilities = learningCapabilitiesSchema.parse(
        await dependencies.getCapabilities(),
      );
      return Response.json(capabilities, { headers: noStore });
    } catch {
      return jsonError(
        503,
        'feature-unavailable',
        'The learning capability is unavailable.',
      );
    }
  };

export const GET = createLearningCapabilitiesHandler({
  getCurrentUser,
  trustedOrigin: new URL(serverEnv.BETTER_AUTH_URL).origin,
  getCapabilities: getLearningCapabilities,
});
