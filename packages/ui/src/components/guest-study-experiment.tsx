'use client';

import { useId, useState } from 'react';
import { ArrowLeft, ArrowLeftRight, ArrowRight } from 'lucide-react';
import { Button } from './button';
import { Label } from './label';
import { Slider } from './slider';

export type DemoExperiment = {
  kind: 'osmosis';
  title: string;
  introduction: string;
  insideConcentration: number;
  outsideConcentration: number;
  predictionQuestion: string;
};

export const parseDemoExperiment = (value: unknown): DemoExperiment | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some(
      (key) =>
        ![
          'kind',
          'title',
          'introduction',
          'insideConcentration',
          'outsideConcentration',
          'predictionQuestion',
        ].includes(key),
    ) ||
    item.kind !== 'osmosis' ||
    typeof item.title !== 'string' ||
    !item.title.trim() ||
    item.title.length > 80 ||
    typeof item.introduction !== 'string' ||
    !item.introduction.trim() ||
    item.introduction.length > 280 ||
    typeof item.predictionQuestion !== 'string' ||
    !item.predictionQuestion.trim() ||
    item.predictionQuestion.length > 180 ||
    typeof item.insideConcentration !== 'number' ||
    !Number.isInteger(item.insideConcentration) ||
    item.insideConcentration < 0 ||
    item.insideConcentration > 10 ||
    typeof item.outsideConcentration !== 'number' ||
    !Number.isInteger(item.outsideConcentration) ||
    item.outsideConcentration < 0 ||
    item.outsideConcentration > 10
  )
    return null;
  return item as DemoExperiment;
};

type Prediction = 'enters' | 'leaves' | 'balanced';
const predictions: Array<{ value: Prediction; label: string }> = [
  { value: 'enters', label: 'Water enters the cell' },
  { value: 'leaves', label: 'Water leaves the cell' },
  { value: 'balanced', label: 'No net water movement' },
];

/** Trusted local renderer. The model configures numbers and text, never code. */
export const GuestStudyExperiment = ({
  experiment,
}: {
  experiment: DemoExperiment;
}) => {
  const id = useId();
  const [inside, setInside] = useState(experiment.insideConcentration);
  const [outside, setOutside] = useState(experiment.outsideConcentration);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [revealed, setRevealed] = useState(false);
  const outcome: Prediction =
    inside > outside ? 'enters' : inside < outside ? 'leaves' : 'balanced';
  const change = (
    side: 'inside' | 'outside',
    value: number | readonly number[],
  ) => {
    const next = Array.isArray(value) ? value[0]! : (value as number);
    if (side === 'inside') setInside(next);
    else setOutside(next);
    setPrediction(null);
    setRevealed(false);
  };
  return (
    <section
      aria-label="Model-configured osmosis experiment"
      className="space-y-6"
    >
      <header className="space-y-2">
        <h3 className="text-balance text-lg font-semibold">
          {experiment.title}
        </h3>
        <p className="text-pretty text-sm text-muted-foreground">
          Live Meta scenario · trusted local experiment
        </p>
      </header>
      <div className="space-y-6">
        <p className="text-pretty">{experiment.introduction}</p>
        <p className="text-pretty text-sm text-muted-foreground">
          Simplified membrane model: water can cross; dissolved solute cannot.
        </p>
        <div
          className="flex items-center gap-3"
          aria-label="Cell membrane scenario"
        >
          <div className="min-w-0 flex-1 rounded-lg bg-muted p-4 text-center">
            <p className="font-medium">Inside the cell</p>
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="tabular-nums">{inside}</span> solute units
            </p>
          </div>
          <div
            aria-hidden="true"
            className="flex size-8 items-center justify-center text-primary"
          >
            {!revealed ? (
              <span>?</span>
            ) : outcome === 'enters' ? (
              <ArrowLeft />
            ) : outcome === 'leaves' ? (
              <ArrowRight />
            ) : (
              <ArrowLeftRight />
            )}
          </div>
          <div className="min-w-0 flex-1 rounded-lg bg-muted p-4 text-center">
            <p className="font-medium">Outside the cell</p>
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="tabular-nums">{outside}</span> solute units
            </p>
          </div>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          {(['inside', 'outside'] as const).map((side) => (
            <div key={side} className="space-y-3">
              <Label id={`${id}-${side}-label`} htmlFor={`${id}-${side}`}>
                {side === 'inside' ? 'Inside' : 'Outside'} solute:{' '}
                <span className="tabular-nums">
                  {side === 'inside' ? inside : outside}
                </span>
              </Label>
              <Slider
                id={`${id}-${side}`}
                aria-labelledby={`${id}-${side}-label`}
                value={[side === 'inside' ? inside : outside]}
                min={0}
                max={10}
                step={1}
                onValueChange={(value) => change(side, value)}
              />
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <p id={`${id}-question`} className="text-pretty font-medium">
            {experiment.predictionQuestion}
          </p>
          <div
            role="group"
            aria-labelledby={`${id}-question`}
            className="flex flex-wrap gap-2"
          >
            {predictions.map(({ value, label }) => (
              <Button
                key={value}
                variant={prediction === value ? 'default' : 'outline'}
                aria-pressed={prediction === value}
                onClick={() => {
                  setPrediction(value);
                  setRevealed(false);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          <Button
            variant="secondary"
            disabled={!prediction}
            onClick={() => setRevealed(true)}
          >
            Reveal result
          </Button>
        </div>
        {revealed && (
          <p role="status" className="text-pretty">
            {prediction === outcome
              ? 'Your prediction matches. '
              : 'Compare your prediction with the result. '}
            {outcome === 'balanced'
              ? 'The concentrations are equal, so there is no net water movement in this model.'
              : `In this model, water ${outcome === 'enters' ? 'enters' : 'leaves'} the cell toward the higher solute concentration across the selectively permeable membrane.`}
          </p>
        )}
      </div>
    </section>
  );
};
