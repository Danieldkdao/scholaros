'use client';

import { authClient } from '@scholaros/auth/client';
import {
  getAuthRedirect,
  getDesktopAuthQuery,
  localReturnPath,
} from '@scholaros/auth/redirects';
import type { SetterType } from '@scholaros/lib/types';
import {
  verifyAccountSchema,
  type VerifyAccountSchema,
} from '@/lib/auth/schemas';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from '@scholaros/ui/components/toast';
import { Card, CardContent } from '@scholaros/ui/components/card';
import {
  Field,
  FieldContent,
  FieldError,
  FieldLabel,
} from '@scholaros/ui/components/field';
import { OTPInput } from '@scholaros/ui/components/otp-input';
import { Button } from '@scholaros/ui/components/button';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { useRouter, useSearchParams } from 'next/navigation';

type VerifyAccountProps = {
  email: string;
  setEmail: SetterType<string | null>;
  redirectTo?: string;
};

const formatResendLabel = (seconds: number) =>
  seconds > 0 ? `Resend (${seconds.toString().padStart(2, '0')})` : 'Resend';

export const VerifyAccount = ({
  email,
  setEmail,
  redirectTo = '/',
}: VerifyAccountProps) => {
  const router = useRouter();
  const params = useSearchParams();
  const desktopQuery = getDesktopAuthQuery(params);
  const [timeToResend, setTimeToResend] = useState(30);
  const [isResending, setIsResending] = useState(false);
  const form = useForm<VerifyAccountSchema>({
    resolver: zodResolver(verifyAccountSchema),
    defaultValues: { otp: '' },
  });
  const busy = isResending || form.formState.isSubmitting;

  useEffect(() => {
    if (timeToResend <= 0) return;
    const interval = setInterval(
      () => setTimeToResend((prev) => Math.max(0, prev - 1)),
      1000,
    );
    return () => clearInterval(interval);
  }, [timeToResend]);

  const handleVerification = async ({ otp }: VerifyAccountSchema) => {
    form.clearErrors('otp');
    try {
      const result = await authClient.emailOtp.verifyEmail({
        email,
        otp,
        fetchOptions: { query: desktopQuery ?? undefined },
      });
      if (result.error) {
        form.setError('otp', {
          type: 'server',
          message:
            result.error.message ||
            'Could not verify this code. Please try again.',
        });
        return;
      }
      toast.success('Account verified successfully!');
      router.replace(
        desktopQuery ? getAuthRedirect(params) : localReturnPath(redirectTo),
      );
      router.refresh();
    } catch {
      toast.error('We couldn’t reach account services. Please try again.');
    }
  };

  const handleResend = async () => {
    if (timeToResend > 0 || busy) return;
    setIsResending(true);
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: 'email-verification',
      });
      if (result.error) {
        toast.error(
          result.error.message ||
            'Could not send another code. Please try again.',
        );
        return;
      }
      form.clearErrors('otp');
      form.reset({ otp: '' });
      setTimeToResend(30);
      toast.success('OTP email resent successfully!');
    } catch {
      toast.error('We couldn’t reach account services. Please try again.');
    } finally {
      setIsResending(false);
    }
  };

  return (
    <Card className="w-full max-w-[30rem] rounded-2xl text-base shadow-none">
      <CardContent className="items-center gap-4">
        <div className="mb-4 flex flex-col items-center gap-2">
          <h1 className="text-center font-sans text-3xl font-semibold">
            Verify Account
          </h1>
          <p className="text-center text-base text-muted-foreground">
            Enter the 6-digit verification code sent to{' '}
            <span className="font-semibold">{email}</span>. You can request a
            new code below.
          </p>
        </div>
        <form
          noValidate
          onSubmit={form.handleSubmit(handleVerification)}
          className="w-full flex flex-col gap-4"
        >
          <Controller
            name="otp"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="verification-code" className="sr-only">
                  Verification code
                </FieldLabel>
                <FieldContent>
                  <OTPInput
                    {...field}
                    id="verification-code"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    disabled={busy}
                    aria-required="true"
                    aria-invalid={fieldState.invalid}
                    aria-describedby={
                      fieldState.invalid ? 'otp-error' : undefined
                    }
                  />
                </FieldContent>
                <FieldError
                  id="otp-error"
                  errors={[fieldState.error]}
                  className="text-base"
                />
              </Field>
            )}
          />
          <Button
            className="h-11 w-full text-base"
            type="submit"
            aria-label="Continue"
            aria-busy={form.formState.isSubmitting}
            disabled={busy}
          >
            <LoadingSwap isLoading={form.formState.isSubmitting}>
              Continue
            </LoadingSwap>
          </Button>
        </form>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="text-base text-muted-foreground">
            Didn&apos;t receive a code?
          </span>
          <Button
            type="button"
            variant="ghost"
            className="text-base tabular-nums"
            aria-label={formatResendLabel(timeToResend)}
            aria-busy={isResending}
            disabled={busy || timeToResend > 0}
            onClick={handleResend}
          >
            <LoadingSwap isLoading={isResending}>
              {formatResendLabel(timeToResend)}
            </LoadingSwap>
          </Button>
        </div>
        <Button
          type="button"
          className="w-full text-base"
          variant="outline"
          disabled={busy}
          onClick={() => setEmail(null)}
        >
          Change email
        </Button>
      </CardContent>
    </Card>
  );
};
