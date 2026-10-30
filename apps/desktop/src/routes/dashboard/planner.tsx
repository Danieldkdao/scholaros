import { createFileRoute } from '@tanstack/react-router';
import { PageHeading } from '../../features/dashboard/page-heading';

const PlannerPage = () => <PageHeading page="planner" />;

export const Route = createFileRoute('/dashboard/planner')({
  component: PlannerPage,
});
