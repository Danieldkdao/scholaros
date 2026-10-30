import { createFileRoute } from '@tanstack/react-router';
import { PageHeading } from '../../features/dashboard/page-heading';

const TodayPage = () => <PageHeading page="today" />;

export const Route = createFileRoute('/dashboard/')({
  component: TodayPage,
});
