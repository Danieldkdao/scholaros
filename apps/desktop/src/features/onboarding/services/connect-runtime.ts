import { createConnectCoordinator } from './connect-coordinator';
import type { createConnectionApprovalStore } from './connection-approval';

type Dependencies = Parameters<typeof createConnectCoordinator>[0] & {
  approvals: ReturnType<typeof createConnectionApprovalStore>;
};

export const createConnectRuntime = ({
  approvals,
  ...dependencies
}: Dependencies) => {
  const coordinator = createConnectCoordinator(dependencies);
  const start = async (accountId: string, proposalId: string) => {
    if (coordinator.isBusy())
      throw new Error('A connection run is already active.');
    const approved = approvals.consume(accountId, proposalId);
    await coordinator.start(accountId, approved);
  };
  return { ...coordinator, start };
};
