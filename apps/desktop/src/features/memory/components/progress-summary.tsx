import type {
  LearningProgress,
  ProgressItem,
} from '@scholaros/services/learning/memory-contracts';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@scholaros/ui/components/alert';
import { Badge } from '@scholaros/ui/components/badge';
import { Button } from '@scholaros/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@scholaros/ui/components/empty';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@scholaros/ui/components/item';
import { Skeleton } from '@scholaros/ui/components/skeleton';
import { BookOpen, CircleHelp } from 'lucide-react';
import {
  formatMemoryLoadStatus,
  formatSourceLocator,
  formatSourceReferenceState,
  formatUnknownProgressCount,
} from '../lib/formatters';
import { useLearningProgress } from '../hooks/use-memory';

export type ProgressSummaryProps = {
  accountId: string;
  courseId?: string;
  variant?: 'card' | 'embedded';
};

type ProgressSectionProps = {
  title: string;
  emptyLabel: string;
  items: ProgressItem[];
};

const ProgressEvidence = ({ item }: { item: ProgressItem }) => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge variant="secondary" className="h-auto text-base">
      {item.assisted ? 'Assisted evidence' : 'Independent evidence'}
    </Badge>
    {item.evidenceIds.length > 0 && (
      <Badge variant="outline" className="h-auto text-base">
        {item.evidenceIds.length === 1
          ? '1 observation'
          : `${item.evidenceIds.length} observations`}
      </Badge>
    )}
    {item.sourceReferences.map((reference) => {
      const referenceState = formatSourceReferenceState(reference.state);
      const locator = formatSourceLocator(reference.locator);
      return (
        <Badge
          key={`${reference.sourceKind}-${reference.sourceId}-${reference.versionId ?? ''}`}
          variant="outline"
          className="h-auto max-w-full whitespace-normal text-base"
        >
          <referenceState.Icon aria-hidden="true" />
          <span className="break-words">{reference.title}</span>
          <span>{referenceState.label}</span>
          {locator && <span>{locator}</span>}
        </Badge>
      );
    })}
    {item.evidenceIds.length === 0 && item.sourceReferences.length === 0 && (
      <span className="text-base text-muted-foreground">
        No source reference is available for this observation.
      </span>
    )}
  </div>
);

const ProgressSection = ({
  title,
  emptyLabel,
  items,
}: ProgressSectionProps) => (
  <section className="flex min-w-0 flex-col gap-3" aria-label={title}>
    <h3 className="text-lg font-semibold">{title}</h3>
    {items.length === 0 ? (
      <p className="text-base text-muted-foreground">{emptyLabel}</p>
    ) : (
      <ItemGroup>
        {items.map((item, index) => (
          <Item
            key={`${item.conceptId ?? item.label}-${index}`}
            role="listitem"
            variant="outline"
            className="items-start text-base"
          >
            <ItemContent className="min-w-0">
              <ItemTitle role="heading" aria-level={4} className="text-base">
                {item.label}
              </ItemTitle>
              <ItemDescription className="line-clamp-none text-base">
                {item.summary}
              </ItemDescription>
              <ProgressEvidence item={item} />
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    )}
  </section>
);

const ProgressSections = ({ progress }: { progress: LearningProgress }) => (
  <div className="flex min-w-0 flex-col gap-5">
    {progress.unknownCount > 0 && (
      <Item variant="muted" className="text-base">
        <CircleHelp
          aria-hidden="true"
          className="size-5 text-muted-foreground"
        />
        <ItemContent>
          <ItemTitle role="heading" aria-level={3} className="text-base">
            Not enough evidence yet
          </ItemTitle>
          <ItemDescription className="text-base">
            {formatUnknownProgressCount(progress.unknownCount)}.
          </ItemDescription>
        </ItemContent>
      </Item>
    )}
    <ProgressSection
      title="Strengths"
      emptyLabel="No strengths are recorded yet."
      items={progress.strengths}
    />
    <ProgressSection
      title="Topics to practice"
      emptyLabel="No topics are currently marked for practice."
      items={progress.practiceTopics}
    />
    <ProgressSection
      title="Recent changes"
      emptyLabel="No recent learning changes are recorded yet."
      items={progress.recentChanges}
    />
  </div>
);

export const ProgressSummary = ({
  accountId,
  courseId,
  variant = 'card',
}: ProgressSummaryProps) => {
  const progressState = useLearningProgress(accountId, courseId);
  const status = formatMemoryLoadStatus(progressState.status);

  const content = (
    <>
      {progressState.status === 'loading' && (
        <div
          aria-busy="true"
          aria-label={status.label}
          className="flex flex-col gap-3"
          role="status"
        >
          <Skeleton className="h-16 w-full motion-reduce:animate-none" />
          <Skeleton className="h-16 w-full motion-reduce:animate-none" />
        </div>
      )}
      {(progressState.status === 'error' ||
        progressState.status === 'offline') && (
        <Alert variant="destructive">
          <AlertTitle>{status.label}</AlertTitle>
          <AlertDescription>
            {progressState.error ?? 'Could not load study progress.'}
            <Button
              className="mt-2 w-full sm:w-fit"
              type="button"
              variant="outline"
              onClick={() => void progressState.reload()}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {progressState.status === 'ready' &&
        progressState.progress &&
        (progressState.progress.strengths.length === 0 &&
        progressState.progress.practiceTopics.length === 0 &&
        progressState.progress.recentChanges.length === 0 &&
        progressState.progress.unknownCount === 0 ? (
          <Empty className={variant === 'embedded' ? 'border-0' : 'border'}>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookOpen aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle role="heading" aria-level={3}>
                No progress evidence yet
              </EmptyTitle>
              <EmptyDescription className="text-base">
                Study responses and practice will appear here when evidence is
                available.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ProgressSections progress={progressState.progress} />
        ))}
    </>
  );
  if (variant === 'embedded') return <div className="min-w-0">{content}</div>;
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          <h2 className="text-xl font-semibold">Learning progress</h2>
        </CardTitle>
        <CardDescription>
          Progress reflects observed study evidence and keeps assisted work
          visible.
        </CardDescription>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
};
