import type {
  ActionCleanup,
  AuthorizedRegistrar,
} from '@scholaros/services/learning/product-contracts';
import { createTutorService, type TutorServiceDependencies } from './tutor';

export const registerTutorActions = (
  registrar: AuthorizedRegistrar,
  dependencies: TutorServiceDependencies,
): ActionCleanup => {
  const tutor = createTutorService(dependencies, registrar.lifecycle);
  registrar.handle('sendStudyTurn', tutor.sendStudyTurn);
  registrar.handle('retryStudyTurn', tutor.retryStudyTurn);
  registrar.handle('cancelStudyTurn', tutor.cancelStudyTurn);
  return tutor.cleanup;
};
