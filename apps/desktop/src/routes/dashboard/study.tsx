import { createFileRoute } from '@tanstack/react-router';
import { PageHeading } from '../../features/dashboard/page-heading';

const StudyPage = () => <PageHeading page="study" />;

export const Route = createFileRoute('/dashboard/study')({
  component: StudyPage,
});
