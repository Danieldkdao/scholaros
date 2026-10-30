import { createFileRoute } from '@tanstack/react-router';
import { PageHeading } from '../../features/dashboard/page-heading';

const CoursesPage = () => <PageHeading page="courses" />;

export const Route = createFileRoute('/dashboard/courses')({
  component: CoursesPage,
});
