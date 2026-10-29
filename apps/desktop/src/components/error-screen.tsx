import { CircleAlert, RefreshCw } from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';

type ErrorScreenProps = {
  title: string;
  message: string;
  onRetry: () => void;
};

export const ErrorScreen = ({ title, message, onRetry }: ErrorScreenProps) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-5 rounded-xl border bg-card p-8 text-center">
    <CircleAlert className="size-8 text-destructive" />
    <div className="flex flex-col gap-2">
      <h2 className="text-2xl font-semibold">{title}</h2>
      <p className="text-muted-foreground">{message}</p>
    </div>
    <Button variant="outline" className="text-base" onClick={onRetry}>
      <RefreshCw className="size-5" />
      Try again
    </Button>
  </div>
);
