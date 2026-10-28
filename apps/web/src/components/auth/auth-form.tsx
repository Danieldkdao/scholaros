'use client';

import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Send } from 'lucide-react';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { FcGoogle } from 'react-icons/fc';
import { FaGithub } from 'react-icons/fa';
import { authClient } from '@scholaros/auth/client';
import {
  getAuthRedirect,
  getAuthPageHref,
  getDesktopAuthQuery,
} from '@scholaros/auth/redirects';
import { Button } from '@scholaros/ui/components/button';
import { Input } from '@scholaros/ui/components/input';
import { Field, FieldLabel, FieldError } from '@scholaros/ui/components/field';
import {
  authFormSchema,
  signUpFormSchema,
  AuthFormSchema,
} from '@/lib/auth/schemas';
import { Card, CardContent } from '@scholaros/ui/components/card';
import { VerifyAccount } from '@/components/auth/verify-account';
import { toast } from '@scholaros/ui/components/toast';
import { Separator } from '@scholaros/ui/components/separator';
import {
  PasswordInput,
  PasswordInputStrengthChecker,
} from '@scholaros/ui/components/password-input';

export const AuthForm = ({ signup = false }: { signup?: boolean }) => {
  const router = useRouter();
  const params = useSearchParams();
  const [socialProvider, setSocialProvider] = useState<
    'google' | 'github' | null
  >(null);
  const initialEmail =
    params.get('verify') === '1'
      ? authFormSchema.shape.email.safeParse(params.get('email'))
      : null;
  const [verificationEmail, setVerificationEmail] = useState<string | null>(
    initialEmail?.success ? initialEmail.data : null,
  );
  const form = useForm<AuthFormSchema>({
    resolver: zodResolver(signup ? signUpFormSchema : authFormSchema),
    defaultValues: { name: '', email: '', password: '' },
  });
  const { data: session, isPending } = authClient.useSession();
  const busy =
    isPending || socialProvider !== null || form.formState.isSubmitting;
  const next = getAuthRedirect(params);
  const desktopQuery = getDesktopAuthQuery(params);
  const isDesktopRequest = desktopQuery !== null;

  useEffect(() => {
    // Desktop sign-in requires a fresh user action, even with a browser session.
    if (!isDesktopRequest && session?.user.emailVerified) router.replace(next);
  }, [session?.user.emailVerified, isDesktopRequest, next, router]);

  useEffect(() => {
    if (params.get('error'))
      toast.error(
        'Sign-in was cancelled or could not be completed. Please try again.',
      );
  }, [params]);

  const socialSignIn = async (provider: 'google' | 'github') => {
    setSocialProvider(provider);
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: next,
        errorCallbackURL: getAuthPageHref('/sign-in', params),
        fetchOptions: { query: desktopQuery ?? undefined },
      });
      if (result.error)
        toast.error(
          result.error.message || 'Could not sign in. Please try again.',
        );
    } catch {
      toast.error('We couldn’t reach account services. Please try again.');
    } finally {
      setSocialProvider(null);
    }
  };

  const submit = async (values: AuthFormSchema) => {
    try {
      const { name, email, password } = values;
      const result = signup
        ? await authClient.signUp.email({
            email,
            password,
            name,
            callbackURL: next,
            fetchOptions: { query: desktopQuery ?? undefined },
          })
        : await authClient.signIn.email({
            email,
            password,
            callbackURL: next,
            fetchOptions: { query: desktopQuery ?? undefined },
          });
      if (result.error) {
        if (result.error.code === 'EMAIL_NOT_VERIFIED') {
          setVerificationEmail(email);
          form.setValue('password', '');
        } else {
          toast.error(
            result.error.message ||
              'Could not sign in. Check your details and try again.',
          );
        }
        return;
      }
      if (signup || result.data?.user.emailVerified === false) {
        setVerificationEmail(email);
        form.setValue('password', '');
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      toast.error('We couldn’t reach account services. Please try again.');
    }
  };

  if (verificationEmail)
    return (
      <VerifyAccount
        email={verificationEmail}
        setEmail={setVerificationEmail}
        redirectTo={next}
      />
    );

  return (
    <Card className="w-full max-w-[30rem] rounded-2xl text-base shadow-none">
      <CardContent className="gap-0">
        <div className="mb-6 text-center">
          <h1 className="font-sans text-3xl font-semibold">
            {signup ? 'Create your account' : 'Welcome Back'}
          </h1>
          <p className="mt-1 text-base text-muted-foreground">
            {signup
              ? 'Make a little room for understanding.'
              : 'Your next aha moment is waiting.'}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-10 w-full bg-muted/40 text-base font-normal"
            disabled={busy}
            onClick={() => socialSignIn('github')}
            aria-label="Continue with GitHub"
            aria-busy={socialProvider === 'github'}
          >
            <LoadingSwap
              isLoading={socialProvider === 'github'}
              className="flex items-center justify-center gap-2"
            >
              <FaGithub aria-hidden="true" className="size-5" />
              Continue with GitHub
            </LoadingSwap>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 w-full bg-muted/40 text-base font-normal"
            disabled={busy}
            onClick={() => socialSignIn('google')}
            aria-label="Continue with Google"
            aria-busy={socialProvider === 'google'}
          >
            <LoadingSwap
              isLoading={socialProvider === 'google'}
              className="flex items-center justify-center gap-2"
            >
              {/* Google requires its official multicolor identity. */}
              <FcGoogle aria-hidden="true" className="size-5" />
              Continue with Google
            </LoadingSwap>
          </Button>
        </div>
        <div className="flex items-center gap-2 py-5">
          <Separator className="h-px flex-1" />
          <span className="shrink-0 text-base text-muted-foreground">
            Or continue with
          </span>
          <Separator className="h-px flex-1" />
        </div>
        <form
          noValidate
          onSubmit={form.handleSubmit(submit)}
          className="flex flex-col gap-5"
        >
          {signup && (
            <Controller
              name="name"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid} className="gap-2">
                  <FieldLabel htmlFor="name" className="text-base">
                    Your name
                  </FieldLabel>
                  <Input
                    {...field}
                    id="name"
                    className="h-10 bg-muted/40 text-base md:text-base dark:bg-muted/40"
                    autoComplete="name"
                    disabled={busy}
                    aria-required="true"
                    aria-invalid={fieldState.invalid}
                    aria-describedby={
                      fieldState.invalid ? 'name-error' : undefined
                    }
                  />
                  <FieldError
                    id="name-error"
                    errors={[fieldState.error]}
                    className="text-base"
                  />
                </Field>
              )}
            />
          )}
          <Controller
            name="email"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid} className="gap-2">
                <FieldLabel htmlFor="email" className="text-base">
                  Email
                </FieldLabel>
                <Input
                  {...field}
                  id="email"
                  type="email"
                  placeholder="example@email.com"
                  className="h-10 bg-muted/40 text-base md:text-base dark:bg-muted/40"
                  autoComplete="email"
                  disabled={busy}
                  aria-required="true"
                  aria-invalid={fieldState.invalid}
                  aria-describedby={
                    fieldState.invalid ? 'email-error' : undefined
                  }
                />
                <FieldError
                  id="email-error"
                  errors={[fieldState.error]}
                  className="text-base"
                />
              </Field>
            )}
          />
          <Controller
            name="password"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid} className="gap-2">
                <FieldLabel htmlFor="password" className="text-base">
                  Password
                </FieldLabel>
                <PasswordInput
                  {...field}
                  id="password"
                  placeholder="••••••••"
                  className="h-10 bg-muted/40 text-base md:text-base dark:bg-muted/40"
                  autoComplete={signup ? 'new-password' : 'current-password'}
                  disabled={busy}
                  aria-required="true"
                  aria-invalid={fieldState.invalid}
                  aria-describedby={
                    fieldState.invalid ? 'password-error' : undefined
                  }
                >
                  <PasswordInputStrengthChecker />
                </PasswordInput>
                <FieldError
                  id="password-error"
                  errors={[fieldState.error]}
                  className="text-base"
                />
              </Field>
            )}
          />
          <Button
            type="submit"
            disabled={busy}
            className="h-11 w-full text-base"
            aria-label="Continue"
            aria-busy={form.formState.isSubmitting}
          >
            <LoadingSwap
              isLoading={form.formState.isSubmitting}
              className="flex items-center justify-center gap-2"
            >
              <Send aria-hidden="true" />
              Continue
            </LoadingSwap>
          </Button>
        </form>
        <p className="mt-5 text-center text-base text-muted-foreground">
          {signup ? 'Already have an account?' : "Don't have an account?"}{' '}
          <Link
            className="font-medium hover:text-foreground hover:underline hover:underline-offset-4"
            href={getAuthPageHref(signup ? '/sign-in' : '/sign-up', params)}
          >
            {signup ? 'Sign in here' : 'Sign up here'}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
};
