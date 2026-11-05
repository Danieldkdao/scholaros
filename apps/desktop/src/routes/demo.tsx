import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { GuestStudyDemo } from '@scholaros/ui/components/guest-study-demo';

const DemoPage = () => {
  const navigate = useNavigate();
  const exit = () => void navigate({ to: '/auth' });
  return <GuestStudyDemo onExit={exit} onSignIn={exit} />;
};

export const Route = createFileRoute('/demo')({ component: DemoPage });
