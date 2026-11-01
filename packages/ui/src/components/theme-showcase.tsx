'use client';

import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';

import { useEffect, useState, type ReactNode } from 'react';
import { useTheme } from 'next-themes';
import {
  ArrowDown,
  ArrowUpRight,
  BookOpen,
  Monitor,
  Moon,
  Sun,
} from 'lucide-react';
import { Button } from './button';
import { cn } from '../lib/utils';

const swatches = [
  { token: 'background', className: 'bg-background' },
  { token: 'foreground', className: 'bg-foreground' },
  { token: 'card', className: 'bg-card' },
  { token: 'card-foreground', className: 'bg-card-foreground' },
  { token: 'popover', className: 'bg-popover' },
  { token: 'popover-foreground', className: 'bg-popover-foreground' },
  { token: 'primary', className: 'bg-primary' },
  { token: 'primary-foreground', className: 'bg-primary-foreground' },
  { token: 'secondary', className: 'bg-secondary' },
  { token: 'secondary-foreground', className: 'bg-secondary-foreground' },
  { token: 'muted', className: 'bg-muted' },
  { token: 'muted-foreground', className: 'bg-muted-foreground' },
  { token: 'accent', className: 'bg-accent' },
  { token: 'accent-foreground', className: 'bg-accent-foreground' },
  { token: 'destructive', className: 'bg-destructive' },
  { token: 'destructive-foreground', className: 'bg-destructive-foreground' },
  { token: 'border', className: 'bg-border' },
  { token: 'input', className: 'bg-input' },
  { token: 'ring', className: 'bg-ring' },
  { token: 'chart-1', className: 'bg-chart-1' },
  { token: 'chart-2', className: 'bg-chart-2' },
  { token: 'chart-3', className: 'bg-chart-3' },
  { token: 'chart-4', className: 'bg-chart-4' },
  { token: 'chart-5', className: 'bg-chart-5' },
  { token: 'sidebar', className: 'bg-sidebar' },
  { token: 'sidebar-foreground', className: 'bg-sidebar-foreground' },
  { token: 'sidebar-primary', className: 'bg-sidebar-primary' },
  {
    token: 'sidebar-primary-foreground',
    className: 'bg-sidebar-primary-foreground',
  },
  { token: 'sidebar-accent', className: 'bg-sidebar-accent' },
  {
    token: 'sidebar-accent-foreground',
    className: 'bg-sidebar-accent-foreground',
  },
  { token: 'sidebar-border', className: 'bg-sidebar-border' },
  { token: 'sidebar-ring', className: 'bg-sidebar-ring' },
] as const;

export const ThemeShowcase = ({ account }: { account?: ReactNode }) => {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-16 px-6 py-8 text-base sm:px-10 lg:px-16">
      <header className="flex flex-wrap items-center justify-between gap-5 border-b pb-6">
        <a href="#" className="flex items-center gap-3 text-xl font-medium">
          <BookOpen className="size-6 text-primary" aria-hidden="true" />
          ScholarOS
        </a>
        <div className="flex flex-wrap items-center gap-4">
          {account}
          <div
            className="flex gap-1 rounded-lg border bg-card p-1"
            role="group"
            aria-label="Color mode"
          >
            <TooltipWrapper content="Light theme">
              <Button
                className="text-base"
                variant={mounted && theme === 'light' ? 'secondary' : 'ghost'}
                size="icon"
                aria-label="Light theme"
                aria-pressed={mounted && theme === 'light'}
                onClick={() => setTheme('light')}
              >
                <Sun aria-hidden="true" />
              </Button>
            </TooltipWrapper>
            <TooltipWrapper content="Dark theme">
              <Button
                className="text-base"
                variant={mounted && theme === 'dark' ? 'secondary' : 'ghost'}
                size="icon"
                aria-label="Dark theme"
                aria-pressed={mounted && theme === 'dark'}
                onClick={() => setTheme('dark')}
              >
                <Moon aria-hidden="true" />
              </Button>
            </TooltipWrapper>
            <TooltipWrapper content="System theme">
              <Button
                className="text-base"
                variant={mounted && theme === 'system' ? 'secondary' : 'ghost'}
                size="icon"
                aria-label="System theme"
                aria-pressed={mounted && theme === 'system'}
                onClick={() => setTheme('system')}
              >
                <Monitor aria-hidden="true" />
              </Button>
            </TooltipWrapper>
          </div>
        </div>
      </header>

      <section className="flex flex-col justify-between gap-10 lg:flex-row lg:items-end">
        <div className="flex max-w-2xl flex-col items-start gap-6">
          <p className="font-mono text-base text-primary">
            The ScholarOS collection / 01
          </p>
          <h1 className="break-words font-serif text-5xl leading-[1.08] tracking-tight sm:text-6xl">
            A little more clarity.
            <br />
            <span className="text-primary">A world of possibility.</span>
          </h1>
          <p className="max-w-lg text-xl leading-relaxed text-muted-foreground">
            Warm neutrals, thoughtful blues, and three distinct voices for the
            way you learn.
          </p>
          <a
            href="#typography"
            className="flex items-center gap-2 font-medium text-primary"
          >
            Explore the typography{' '}
            <ArrowDown className="size-4" aria-hidden="true" />
          </a>
        </div>
        <div className="flex w-full flex-col gap-6 rounded-xl border bg-primary p-8 text-primary-foreground shadow-lg lg:max-w-xs">
          <BookOpen className="size-8" aria-hidden="true" />
          <p className="font-serif text-3xl leading-snug">
            Your next aha
            <br />
            starts here.
          </p>
          <p>Built for curious minds.</p>
          <div className="flex items-center justify-between border-t border-primary-foreground/20 pt-5 font-mono">
            <span>ScholarOS</span>
            <ArrowUpRight className="size-5" aria-hidden="true" />
          </div>
        </div>
      </section>

      <section id="typography" className="flex scroll-mt-6 flex-col gap-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-2xl font-medium">Three voices. One world.</h2>
          <span className="font-mono text-muted-foreground">
            01 / Typography
          </span>
        </div>
        <div className="flex flex-col gap-4 md:flex-row">
          <article className="flex min-w-0 flex-1 flex-col gap-6 rounded-xl border bg-card p-6 text-card-foreground">
            <p className="text-muted-foreground">Outfit / Everyday clarity</p>
            <p className="text-6xl font-medium">Aa</p>
            <h3 className="text-2xl font-medium">
              Make room for understanding.
            </h3>
            <p className="leading-relaxed">
              A calm, clear voice for navigation, explanations, and the everyday
              details.
            </p>
            <p className="break-words text-muted-foreground">
              ABCDEFGHIJKLMNOPQRSTUVWXYZ
              <br />
              abcdefghijklmnopqrstuvwxyz
              <br />
              0123456789
            </p>
          </article>
          <article className="flex min-w-0 flex-1 flex-col gap-6 rounded-xl border bg-card p-6 text-card-foreground">
            <p className="text-muted-foreground">
              Fraunces / A little character
            </p>
            <p className="font-serif text-6xl">Aa</p>
            <h3 className="font-serif text-2xl">Stay wonderfully curious.</h3>
            <p className="font-serif leading-relaxed">
              An expressive voice for big ideas, quiet discoveries, and moments
              that matter.
            </p>
            <p className="break-words font-serif text-muted-foreground">
              ABCDEFGHIJKLMNOPQRSTUVWXYZ
              <br />
              abcdefghijklmnopqrstuvwxyz
              <br />
              0123456789
            </p>
          </article>
          <article className="flex min-w-0 flex-1 flex-col gap-6 rounded-xl border bg-card p-6 text-card-foreground">
            <p className="text-muted-foreground">
              JetBrains Mono / Precise details
            </p>
            <p className="font-mono text-6xl">Aa</p>
            <h3 className="font-mono text-2xl">Small details, clearly.</h3>
            <p className="font-mono leading-relaxed">
              A precise voice for equations, code, numbers, and useful little
              labels.
            </p>
            <p className="break-all font-mono text-muted-foreground">
              ABCDEFGHIJKLMNOPQRSTUVWXYZ
              <br />
              abcdefghijklmnopqrstuvwxyz
              <br />
              0123456789
            </p>
          </article>
        </div>
      </section>

      <section id="colors" className="flex flex-col gap-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-2xl font-medium">A palette with purpose.</h2>
          <span className="font-mono text-muted-foreground">
            02 / Color tokens
          </span>
        </div>
        <p className="max-w-2xl text-muted-foreground">
          Every surface, foreground, chart, and sidebar color in the selected
          theme.
        </p>
        <div className="flex flex-wrap gap-4">
          {swatches.map(({ token, className }) => (
            <article
              key={token}
              className="flex min-w-0 basis-full flex-col gap-3 rounded-lg border bg-card p-3 text-card-foreground sm:basis-[calc(50%-0.5rem)] lg:basis-[calc(25%-0.75rem)]"
            >
              <div
                className={cn('h-20 rounded-md border', className)}
                aria-hidden="true"
              />
              <p className="break-words font-medium">{token}</p>
              <code className="break-all font-mono text-base text-muted-foreground">
                --{token}
              </code>
            </article>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-2xl font-medium">The finishing touches.</h2>
          <span className="font-mono text-muted-foreground">
            03 / Shape and elevation
          </span>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button className="text-base">Primary action</Button>
          <Button className="text-base" variant="secondary">
            Secondary
          </Button>
          <Button className="text-base" variant="outline">
            Outline
          </Button>
          <Button className="text-base" variant="ghost">
            Ghost
          </Button>
          <Button className="text-base" variant="destructive">
            Destructive
          </Button>
        </div>
        <div className="flex flex-wrap gap-5">
          <div className="flex min-h-24 min-w-36 flex-1 items-center justify-center rounded-sm border bg-card p-4 font-mono text-card-foreground shadow-2xs">
            shadow-2xs
          </div>
          <div className="flex min-h-24 min-w-36 flex-1 items-center justify-center rounded-md border bg-card p-4 font-mono text-card-foreground shadow-xs">
            shadow-xs
          </div>
          <div className="flex min-h-24 min-w-36 flex-1 items-center justify-center rounded-lg border bg-card p-4 font-mono text-card-foreground shadow-sm">
            shadow-sm
          </div>
          <div className="flex min-h-24 min-w-36 flex-1 items-center justify-center rounded-lg border bg-card p-4 font-mono text-card-foreground shadow-md">
            shadow-md
          </div>
          <div className="flex min-h-24 min-w-36 flex-1 items-center justify-center rounded-xl border bg-card p-4 font-mono text-card-foreground shadow-lg">
            shadow-lg
          </div>
          <div className="flex min-h-24 min-w-36 flex-1 items-center justify-center rounded-xl border bg-card p-4 font-mono text-card-foreground shadow-xl">
            shadow-xl
          </div>
          <div className="flex min-h-24 min-w-36 flex-1 items-center justify-center rounded-xl border bg-card p-4 font-mono text-card-foreground shadow-2xl">
            shadow-2xl
          </div>
        </div>
        <p className="font-mono text-muted-foreground">
          Base radius 0.375rem / Letter spacing −0.011em
        </p>
      </section>
      <footer className="flex flex-wrap justify-between gap-3 border-t py-6 text-muted-foreground">
        <span>ScholarOS</span>
        <span>The AI that learns your classes so it can teach you.</span>
      </footer>
    </main>
  );
};
