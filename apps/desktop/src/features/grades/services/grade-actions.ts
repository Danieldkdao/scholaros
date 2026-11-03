import type { GradeSettings } from '@scholaros/services/learning/grade-contracts';
import type {
  AuthorizedContext,
  AuthorizedRegistrar,
  ProductEventV1,
} from '@scholaros/services/learning/product-contracts';
import { collectGradeObservation } from './grade-collector';
import { createGradeService } from './grade-service';
import { gradeStore } from './grade-store';

export type GradeActionDependencies = {
  onSettingsChanged?: (
    context: AuthorizedContext,
    settings: GradeSettings,
    deletedCollected: boolean,
  ) => Promise<void> | void;
};

export const registerGradeActions = (
  registrar: AuthorizedRegistrar,
  dependencies: GradeActionDependencies = {},
) => {
  const service = createGradeService({
    store: gradeStore,
    collect: collectGradeObservation,
    lifecycle: registrar.lifecycle,
    onSettingsChanged: async (context, settings, deletedCollected) => {
      await dependencies.onSettingsChanged?.(
        context,
        settings,
        deletedCollected,
      );
      const event: ProductEventV1 = {
        version: 1,
        accountId: context.userId,
        revision: settings.revision,
        resource: 'grades',
        targetId: null,
      };
      registrar.publish(event);
    },
    onEvidenceUpdated: (context, verification) => {
      registrar.publish({
        version: 1,
        accountId: context.userId,
        revision: verification.policyRevision,
        resource: 'grades',
        targetId: verification.assignmentId,
      });
    },
  });
  let disposed = false;
  const cleanup = async () => {
    if (disposed) return;
    disposed = true;
    await service.dispose();
  };

  registrar.handle('getGradeSettings', (context) =>
    service.getGradeSettings(context),
  );
  registrar.handle('saveGradeSettings', (context, input) =>
    service.saveGradeSettings(context, input),
  );
  registrar.handle('verifyCoursework', (context, input) =>
    service.verifyCoursework(context, input),
  );
  registrar.handle('getVerifiedCourseworkEvidence', (context, input) =>
    service.getVerifiedCourseworkEvidence(context, input),
  );
  registrar.lifecycle.onTeardown(cleanup);
  return cleanup;
};
