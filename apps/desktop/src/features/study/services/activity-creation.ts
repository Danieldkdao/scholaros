import { createHash } from 'node:crypto';

type CreatedActivity = {
  artifactId: string;
  versionId: string;
  attemptId: string;
};
const repairableReasons = new Set([
  'invalid-input',
  'unsafe-content',
  'non-interactive',
]);

/** An invalid generated bundle may be regenerated once; permissions never retry. */
export const createActivityWithValidationRepair = async (
  requestId: string,
  create: (attemptRequestId: string) => Promise<CreatedActivity>,
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
      typeof error.validationReason !== 'string' ||
      !repairableReasons.has(error.validationReason)
    )
      throw error;
    const hash = createHash('sha256')
      .update(`${requestId}:activity-validation-repair:1`)
      .digest('hex');
    const repairRequestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    return create(repairRequestId);
  }
};
