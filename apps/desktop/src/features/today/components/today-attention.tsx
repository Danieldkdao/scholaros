import { ArrowUpRight } from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@scholaros/ui/components/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@scholaros/ui/components/item';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import type {
  AttentionItem,
  FreshnessItem,
  TodayOverview,
} from '@scholaros/services/learning/today-contracts';
import type { SafeRoute } from '@scholaros/services/learning/notification-contracts';
import { formatObservedAt } from '../../onboarding/lib/formatters';
import {
  formatTodayAttentionKind,
  formatTodayFreshness,
} from '../lib/formatters';

type TodayAttentionProps = {
  attention: AttentionItem[];
  freshness: FreshnessItem[];
  courses: TodayOverview['recentCourses'];
  onNavigate: (route: SafeRoute) => void;
};

const routeActionLabel = (route: SafeRoute) => {
  switch (route.kind) {
    case 'today':
      return 'Open Today';
    case 'settings':
      return 'Open settings';
    case 'course':
      return 'Open course';
    case 'context':
      return 'Open Context';
    case 'study':
      return 'Resume study session';
  }
};

export const TodayAttention = ({
  attention,
  freshness,
  courses,
  onNavigate,
}: TodayAttentionProps) => (
  <div className="grid gap-4 xl:grid-cols-2">
    <Card>
      <CardHeader>
        <CardTitle>Needs attention</CardTitle>
      </CardHeader>
      <CardContent>
        {attention.length ? (
          <ItemGroup>
            {attention.map((item) => {
              const { Icon, label } = formatTodayAttentionKind(item.kind);
              const actionLabel = routeActionLabel(item.route);
              return (
                <Item
                  key={item.code}
                  variant="outline"
                  size="sm"
                  role="listitem"
                  className="text-base"
                >
                  <ItemMedia variant="icon">
                    <Icon
                      aria-hidden="true"
                      className="size-4 text-muted-foreground"
                    />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle className="text-base">{label}</ItemTitle>
                    <p className="text-base text-muted-foreground">
                      {item.label}
                    </p>
                  </ItemContent>
                  <ItemActions>
                    <TooltipWrapper content={actionLabel}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={actionLabel}
                        onClick={() => onNavigate(item.route)}
                      >
                        <ArrowUpRight aria-hidden="true" />
                      </Button>
                    </TooltipWrapper>
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        ) : (
          <Empty className="border-0 p-4">
            <EmptyHeader>
              <EmptyTitle>No setup or connection issues</EmptyTitle>
              <EmptyDescription className="text-base">
                Your saved class information is ready to use.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>Course freshness</CardTitle>
      </CardHeader>
      <CardContent>
        {freshness.length ? (
          <ItemGroup>
            {freshness.map((item) => {
              const { Icon, label } = formatTodayFreshness(item.status);
              return (
                <Item
                  key={item.courseId}
                  variant="outline"
                  size="sm"
                  role="listitem"
                  className="text-base"
                >
                  <ItemMedia variant="icon">
                    <Icon
                      aria-hidden="true"
                      className="size-4 text-muted-foreground"
                    />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle className="text-base">
                      {item.courseName ??
                        courses.find((course) => course.id === item.courseId)
                          ?.name ??
                        'Course'}
                      <span className="sr-only">: </span>
                      {label}
                    </ItemTitle>
                    <p className="text-base text-muted-foreground">
                      {item.lastSuccessfulAt
                        ? `Last successful sync: ${formatObservedAt(item.lastSuccessfulAt)}`
                        : 'No successful sync has been recorded.'}
                      {item.pendingCount > 0
                        ? ` ${item.pendingCount} change${item.pendingCount === 1 ? ' is' : 's are'} waiting.`
                        : ''}
                    </p>
                  </ItemContent>
                  {item.pendingCount > 0 && (
                    <ItemActions>
                      <span
                        className="text-base tabular-nums"
                        aria-label={`${item.pendingCount} changes waiting`}
                      >
                        {item.pendingCount}
                      </span>
                    </ItemActions>
                  )}
                </Item>
              );
            })}
          </ItemGroup>
        ) : (
          <Empty className="border-0 p-4">
            <EmptyHeader>
              <EmptyTitle>No connected course sources</EmptyTitle>
              <EmptyDescription className="text-base">
                Connect a class to see its last successful update and pending
                changes.
              </EmptyDescription>
            </EmptyHeader>
            <Button
              variant="outline"
              onClick={() =>
                onNavigate({ kind: 'settings', section: 'connections' })
              }
            >
              Manage connections
            </Button>
          </Empty>
        )}
      </CardContent>
    </Card>
  </div>
);
