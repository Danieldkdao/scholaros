import { createHash } from 'node:crypto';
import path from 'node:path';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

// A Chrome profile cannot be shared across browsers or accounts.
export const profileDirectoryFor = (
  userDataPath: string,
  userId: string,
  executable: string,
) =>
  path.join(userDataPath, 'study-profiles', digest(userId), digest(executable));
