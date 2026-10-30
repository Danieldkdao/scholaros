import { createFileRoute } from '@tanstack/react-router';
import { PageHeading } from '../../features/dashboard/page-heading';

const ConnectionsPage = () => <PageHeading page="connections" />;

export const Route = createFileRoute('/dashboard/connections')({
  component: ConnectionsPage,
});
