import { createFileRoute } from '@tanstack/react-router';
import { PageHeading } from '../../features/dashboard/page-heading';

const SettingsPage = () => <PageHeading page="settings" />;

export const Route = createFileRoute('/dashboard/settings')({
  component: SettingsPage,
});
