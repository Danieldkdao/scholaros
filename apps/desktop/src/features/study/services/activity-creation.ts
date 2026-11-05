import { createHash } from 'node:crypto';
import {
  activityRepairReasonSchema,
  type ActivityRepairReason,
} from '@scholaros/services/learning/activity-contracts';
import { safeErrorCodeSchema } from '@scholaros/services/learning/product-contracts';

type CreatedActivity = {
  artifactId: string;
  versionId: string;
  attemptId: string;
};

const reportActivityCreationFailure = (
  error: unknown,
  phase: 'validation-repair' | 'creation-failed',
  attempt: 1 | 2,
) => {
  try {
    const failure =
      error && typeof error === 'object'
        ? (error as { code?: unknown; validationReason?: unknown })
        : null;
    const code = safeErrorCodeSchema.safeParse(failure?.code);
    const reason = activityRepairReasonSchema.safeParse(
      failure?.validationReason,
    );
    console.warn('[Activity creation]', {
      phase,
      attempt,
      code: code.success ? code.data : 'provider-failed',
      reason: reason.success ? reason.data : null,
    });
  } catch {
    // Diagnostics must never change retries or include raw error details.
  }
};

/** An invalid generated bundle may be regenerated once; permissions never retry. */
export const createActivityWithValidationRepair = async (
  requestId: string,
  create: (
    attemptRequestId: string,
    repairReason?: ActivityRepairReason,
  ) => Promise<CreatedActivity>,
): Promise<CreatedActivity> => {
  try {
    return await create(requestId);
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'invalid-input' ||
      !('validationReason' in error) ||
      !activityRepairReasonSchema.safeParse(error.validationReason).success
    ) {
      reportActivityCreationFailure(error, 'creation-failed', 1);
      throw error;
    }
    reportActivityCreationFailure(error, 'validation-repair', 1);
    const hash = createHash('sha256')
      .update(`${requestId}:activity-validation-repair:1`)
      .digest('hex');
    const repairRequestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    return create(
      repairRequestId,
      activityRepairReasonSchema.parse(error.validationReason),
    ).catch((repairError: unknown) => {
      reportActivityCreationFailure(repairError, 'creation-failed', 2);
      throw repairError;
    });
  }
};
