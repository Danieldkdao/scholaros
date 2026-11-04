import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/dashboard/planner')({
  beforeLoad: () => {
    throw redirect({ to: '/dashboard/context' });
  },
});
