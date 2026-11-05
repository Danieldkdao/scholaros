'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  FileText,
  FlaskConical,
  GraduationCap,
  Play,
  Sparkles,
} from 'lucide-react';
import { Button } from './button';
import { Badge } from './badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './card';
import { Label } from './label';
import { Slider } from './slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
import { Textarea } from './textarea';

export type GuestStudyDemoProps = {
  onExit?: () => void;
  onSignIn?: () => void;
  signInHref?: string;
  apiBaseURL?: string;
};
const steps = ['Today', 'Courses', 'Context', 'Study'] as const;

/** An isolated sample workspace: state lives only in this mounted component. */
export const GuestStudyDemo = ({
  onExit,
  onSignIn,
  signInHref = '/sign-in',
  apiBaseURL,
}: GuestStudyDemoProps) => {
  const [step, setStep] = useState<string>('Today');
  const [note, setNote] = useState(
    'I learn best with small examples, then a chance to try it myself.',
  );
  const [repetitions, setRepetitions] = useState(3);
  const [answer, setAnswer] = useState<string | null>(null);
  const [liveResult, setLiveResult] = useState<{
    text: string;
    model: string;
  } | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [livePending, setLivePending] = useState(false);
  const liveRequest = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      liveRequest.current?.abort();
      liveRequest.current = null;
    },
    [],
  );
  const requestLiveSample = async (action: 'explain' | 'quiz') => {
    if (liveRequest.current) return;
    const controller = new AbortController();
    liveRequest.current = controller;
    setLivePending(true);
    setLiveError(null);
    try {
      const endpoint = apiBaseURL
        ? new URL('/api/demo/tutor', apiBaseURL).href
        : '/api/demo/tutor';
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(35_000),
        ]),
      });
      if (!response.ok)
        throw new Error(
          response.status === 503
            ? 'Live AI is not enabled on this demo server. The sample activities still work.'
            : response.status === 429
              ? 'The live demo is busy. Try again shortly, or explore the sample activity.'
              : 'The live model could not respond. Please try again.',
        );
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== 'object' ||
        !('text' in result) ||
        typeof result.text !== 'string' ||
        !result.text.trim() ||
        result.text.length > 32_000 ||
        !('model' in result) ||
        typeof result.model !== 'string' ||
        result.model.length > 100
      )
        throw new Error(
          'The live response could not be read. Please try again.',
        );
      if (liveRequest.current === controller)
        setLiveResult({ text: result.text, model: result.model });
    } catch (error) {
      if (liveRequest.current === controller && !controller.signal.aborted)
        setLiveError(
          error instanceof Error &&
            error.message.startsWith('Live AI is not enabled')
            ? error.message
            : error instanceof Error &&
                error.message.startsWith('The live demo is busy')
              ? error.message
              : 'The live model could not respond. Please try again. The sample activity is still available.',
        );
    } finally {
      if (liveRequest.current === controller) {
        liveRequest.current = null;
        setLivePending(false);
      }
    }
  };
  const noteId = useId();
  const sliderId = useId();
  const stepIndex = steps.findIndex((item) => item === step);
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-6 sm:px-8 sm:py-10">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <GraduationCap className="size-7 text-primary" aria-hidden="true" />
            <span className="text-lg font-semibold">ScholarOS</span>
            <Badge variant="secondary">Interactive demo</Badge>
          </div>
          <div className="flex items-center gap-2">
            {onExit && (
              <Button variant="ghost" onClick={onExit}>
                <ArrowLeft aria-hidden="true" />
                Exit demo
              </Button>
            )}
            {onSignIn ? (
              <Button onClick={onSignIn}>Sign in</Button>
            ) : (
              <Button render={<a href={signInHref} />} nativeButton={false}>
                Sign in
              </Button>
            )}
          </div>
        </header>
        <section className="flex flex-col gap-3" aria-label="About this demo">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">Sample data</Badge>
            <Badge variant="outline">No account needed</Badge>
          </div>
          <h1 className="text-balance text-3xl font-semibold sm:text-4xl">
            Meet your study workspace.
          </h1>
          <p className="max-w-2xl text-pretty text-base text-muted-foreground">
            Explore a fictional student’s day, add a note, and try a small
            Python activity. Everything here is a prepared sample; no school
            accounts or AI services are connected.
          </p>
        </section>
        <Tabs
          value={step}
          onValueChange={(value) => setStep(String(value))}
          className="gap-6"
        >
          <TabsList
            className="grid h-auto w-full grid-cols-2 gap-1 group-data-horizontal/tabs:h-auto sm:grid-cols-4"
            aria-label="Demo walkthrough"
          >
            {steps.map((item) => (
              <TabsTrigger key={item} value={item} className="min-h-11">
                {item}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="Today" className="space-y-6">
            <div>
              <h2 className="text-balance text-2xl font-semibold">
                A clear view of what matters.
              </h2>
              <p className="mt-2 text-pretty text-muted-foreground">
                Your classes, upcoming work, and a focused next step, together.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CalendarDays aria-hidden="true" className="size-4" />
                    Coming up
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="font-medium">Python loops practice</p>
                  <p className="text-muted-foreground">
                    Introduction to programming · Tomorrow
                  </p>
                  <Badge variant="secondary">Sample assignment</Badge>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BookOpen aria-hidden="true" className="size-4" />
                    Ready to revisit
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="font-medium">Biology: cell transport</p>
                  <p className="text-muted-foreground">
                    A sample course note is ready for a concept review.
                  </p>
                  <Badge variant="secondary">Sample material</Badge>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles aria-hidden="true" className="size-4" />A focused
                    next step
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-pretty text-muted-foreground">
                    Try a short lesson on how Python repeats an action.
                  </p>
                  <Button onClick={() => setStep('Study')}>
                    <Play aria-hidden="true" />
                    Try the study activity
                  </Button>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
          <TabsContent value="Courses" className="space-y-6">
            <div>
              <h2 className="text-balance text-2xl font-semibold">
                A home for every course.
              </h2>
              <p className="mt-2 text-pretty text-muted-foreground">
                Connected assignments and course materials stay organized by
                class. These two courses are fictional.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BookOpen
                      className="size-5 text-primary"
                      aria-hidden="true"
                    />
                    Introduction to programming
                  </CardTitle>
                  <CardDescription>
                    Sample course · Python fundamentals
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-pretty text-muted-foreground">
                    Explore variables, loops, and how to reason about a program.
                  </p>
                  <Button variant="outline" onClick={() => setStep('Study')}>
                    Explore a sample lesson
                    <ArrowRight aria-hidden="true" />
                  </Button>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FlaskConical
                      className="size-5 text-primary"
                      aria-hidden="true"
                    />
                    Biology
                  </CardTitle>
                  <CardDescription>
                    Sample course · Cell transport
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-pretty text-muted-foreground">
                    Example material: a short note about how cell membranes
                    regulate movement.
                  </p>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
          <TabsContent value="Context" className="space-y-6">
            <div>
              <h2 className="text-balance text-2xl font-semibold">
                Bring the context that helps you learn.
              </h2>
              <p className="mt-2 text-pretty text-muted-foreground">
                In your own workspace, add notes and materials and link them to
                courses. Try editing this sample learning preference.
              </p>
            </div>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText aria-hidden="true" className="size-5" />
                  Your learning note
                </CardTitle>
                <CardDescription>
                  Demo only · Kept only while this demo is open
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Label htmlFor={noteId}>How do you like to learn?</Label>
                <Textarea
                  id={noteId}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={1000}
                  className="min-h-28 resize-none"
                />
                <p className="text-pretty text-sm text-muted-foreground">
                  This note stays in this browser view. It is not uploaded or
                  saved to an account.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="Study" className="space-y-6">
            <div>
              <h2 className="text-balance text-2xl font-semibold">
                Understand it. Try it. Make it stick.
              </h2>
              <p className="mt-2 text-pretty text-muted-foreground">
                A prepared example of a learning conversation with an
                interactive activity alongside it.
              </p>
            </div>
            <Card>
              <CardHeader>
                <CardTitle>Try a live Meta response</CardTitle>
                <CardDescription>
                  These fixed sample questions make a real model call without an
                  account. Your notes and personal data are not sent.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-3">
                  <Button
                    disabled={livePending}
                    onClick={() => void requestLiveSample('explain')}
                  >
                    Ask Meta to explain loops
                  </Button>
                  <Button
                    variant="outline"
                    disabled={livePending}
                    onClick={() => void requestLiveSample('quiz')}
                  >
                    Ask Meta for a practice question
                  </Button>
                </div>
                {livePending && (
                  <p role="status" className="text-sm text-muted-foreground">
                    Meta is preparing a live response…
                  </p>
                )}
                {liveError && (
                  <p
                    role="alert"
                    className="text-pretty text-sm text-destructive"
                  >
                    {liveError}
                  </p>
                )}
                {liveResult && (
                  <section aria-label="Live AI response" className="space-y-3">
                    <Badge variant="secondary">
                      Live response · {liveResult.model}
                    </Badge>
                    <p className="whitespace-pre-wrap break-words text-pretty">
                      {liveResult.text}
                    </p>
                  </section>
                )}
              </CardContent>
            </Card>
            <div className="grid gap-6 lg:grid-cols-2">
              <section
                className="space-y-5"
                aria-label="Sample study conversation"
              >
                <Badge variant="secondary">
                  Prewritten sample conversation
                </Badge>
                <p className="rounded-xl bg-muted px-4 py-3">
                  Can you help me understand Python loops?
                </p>
                <div className="space-y-3">
                  <p className="text-pretty">
                    A loop repeats an action. In Python,{' '}
                    <code className="rounded bg-muted px-1 py-0.5">
                      range(3)
                    </code>{' '}
                    gives you three numbers: 0, 1, and 2. The ending number
                    itself is not included.
                  </p>
                  <p className="text-pretty text-muted-foreground">
                    Try changing the repetition count. Notice that counting
                    starts at zero, while the number of printed lines matches
                    the count you choose.
                  </p>
                </div>
                <p className="text-pretty text-sm text-muted-foreground">
                  Your sample preference:{' '}
                  {note || 'Add a learning note in Context.'}
                </p>
              </section>
              <Card>
                <CardHeader>
                  <CardTitle>Explore a Python loop</CardTitle>
                  <CardDescription>
                    A working local simulation, not a live model response.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-4">
                    <Label htmlFor={sliderId} id={`${sliderId}-label`}>
                      Repetitions:{' '}
                      <span className="tabular-nums">{repetitions}</span>
                    </Label>
                    <Slider
                      id={sliderId}
                      aria-labelledby={`${sliderId}-label`}
                      value={[repetitions]}
                      min={1}
                      max={8}
                      step={1}
                      onValueChange={(value) =>
                        setRepetitions(Array.isArray(value) ? value[0]! : value)
                      }
                    />
                  </div>
                  <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-sm">
                    <code>{`for i in range(${repetitions}):\n    print(i)`}</code>
                  </pre>
                  <div>
                    <p className="mb-2 text-sm font-medium">Output</p>
                    <pre
                      data-testid="loop-output"
                      aria-live="polite"
                      className="rounded-lg border border-border p-4 font-mono text-sm tabular-nums"
                    >
                      {Array.from(
                        { length: repetitions },
                        (_, index) => index,
                      ).join('\n')}
                    </pre>
                  </div>
                </CardContent>
              </Card>
            </div>
            <Card>
              <CardHeader>
                <CardTitle>Check your understanding</CardTitle>
                <CardDescription>
                  What does <code>range(3)</code> produce?
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-3">
                  {['1, 2, 3', '0, 1, 2', '0, 1, 2, 3'].map((option) => (
                    <Button
                      key={option}
                      variant={answer === option ? 'default' : 'outline'}
                      onClick={() => setAnswer(option)}
                    >
                      {option}
                    </Button>
                  ))}
                </div>
                {answer && (
                  <p role="status" className="text-pretty">
                    {answer === '0, 1, 2'
                      ? 'Exactly. Python starts at zero and stops before the ending number.'
                      : 'Try again. range starts at zero and does not include its ending number.'}
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6">
          <p className="flex max-w-xl items-center gap-2 text-pretty text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
            Your full AI workspace and connected courses require sign-in. This
            demo does not access your files, microphone, or school.
          </p>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground tabular-nums">
              {stepIndex + 1} / {steps.length}
            </span>
            <Button
              variant="outline"
              onClick={() => setStep(steps[(stepIndex + 1) % steps.length]!)}
            >
              {step === 'Study' ? 'Back to Today' : 'Continue'}
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        </footer>
      </div>
    </main>
  );
};
